'use strict';

const crypto = require('crypto');
const express = require('express');
const { createLogger, safeError } = require('../src/utils/logger');
const { sleep, computeBackoffMs } = require('../src/utils/retry');
const { signBody } = require('../src/services/webhook-auth.service');
const { createSlidingWindowLimiter } = require('./sliding-window');
const { buildVendorRecord } = require('./sample-data');

function createAsyncVendorApp(options) {
  const log = options.log || createLogger('info');
  const limiter = createSlidingWindowLimiter({
    limit: options.rateLimit,
    windowMs: options.rateWindowMs,
  });
  // Same request_id returns the same vendor_job_id and does not schedule a
  // second callback. This map is in-memory, so it resets when the process restarts.
  const submissions = new Map();
  const stats = {
    requests: 0,
    limited: 0,
    accepted: 0,
    webhookAttempts: 0,
    webhookDelivered: 0,
  };
  const timers = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ strict: false, limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/stats', (req, res) => {
    res.json(stats);
  });

  app.post('/vendor/jobs', (req, res) => {
    stats.requests += 1;
    const requestId = req.body && typeof req.body.request_id === 'string' ? req.body.request_id : '';
    if (!requestId) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const existing = submissions.get(requestId);
    if (existing) {
      res.status(202).json({ vendor_job_id: existing.vendorJobId, status: 'accepted' });
      return;
    }

    const decision = limiter.tryTake();
    if (!decision.allowed) {
      stats.limited += 1;
      const seconds = Math.max(1, Math.ceil((decision.retryAfterMs || 1000) / 1000));
      res.set('Retry-After', String(seconds));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const scenario = req.body && typeof req.body.scenario === 'string' ? req.body.scenario : 'success';
    if (scenario === 'rate_limit') {
      res.set('Retry-After', '1');
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if (scenario === 'server_error') {
      res.status(500).json({ error: 'vendor_unavailable' });
      return;
    }
    if (scenario === 'malformed') {
      res.status(200).type('text/plain').send('not-json');
      return;
    }

    const vendorJobId = crypto.randomUUID();
    const webhookUrl = (req.body && typeof req.body.webhook_url === 'string' && req.body.webhook_url)
      || options.webhookUrl;
    submissions.set(requestId, { vendorJobId });
    stats.accepted += 1;

    // The submission response is only an acknowledgement. The result is
    // delivered later to the webhook, even when the scenario is a failure.
    res.status(202).json({ vendor_job_id: vendorJobId, status: 'accepted' });
    log.info('async_vendor_accepted', { request_id: requestId });

    const timer = setTimeout(() => {
      timers.delete(timer);
      deliverWithRetry({ requestId, vendorJobId, webhookUrl, scenario }).catch((err) => {
        log.error('webhook_delivery_crashed', { request_id: requestId, ...safeError(err) });
      });
    }, options.delayMs);
    timers.add(timer);
  });

  async function deliverWithRetry({ requestId, vendorJobId, webhookUrl, scenario }) {
    if (!webhookUrl) {
      log.error('webhook_url_missing', { request_id: requestId });
      return;
    }

    const body = scenario === 'fail'
      ? {
        request_id: requestId,
        vendor_job_id: vendorJobId,
        status: 'failed',
        error_code: 'vendor_rejected',
      }
      : {
        request_id: requestId,
        vendor_job_id: vendorJobId,
        status: 'success',
        result: buildVendorRecord(requestId),
      };
    const raw = Buffer.from(JSON.stringify(body));
    const signature = signBody(raw, options.webhookSecret);

    for (let attempt = 1; attempt <= options.webhookMaxRetries; attempt += 1) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vendor-signature': signature,
          },
          body: raw,
          signal: AbortSignal.timeout(options.webhookTimeoutMs),
        });
        stats.webhookAttempts += 1;
        if (response.status >= 200 && response.status < 300) {
          stats.webhookDelivered += 1;
          log.info('webhook_delivered', { request_id: requestId, attempt });
          return;
        }
        // 4xx other than 429 will not succeed on retry (bad signature, unknown job).
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          log.error('webhook_rejected', { request_id: requestId, status: response.status });
          return;
        }
        log.error('webhook_attempt_failed', { request_id: requestId, attempt, status: response.status });
      } catch (err) {
        stats.webhookAttempts += 1;
        log.error('webhook_attempt_failed', { request_id: requestId, attempt, ...safeError(err) });
      }

      if (attempt < options.webhookMaxRetries) {
        await sleep(computeBackoffMs(attempt, {
          baseMs: options.webhookRetryBaseMs,
          capMs: 5000,
        }));
      }
    }
    log.error('webhook_gave_up', { request_id: requestId });
  }

  function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { app, stats, close };
}

function startAsyncVendor(config) {
  const log = createLogger(config.logLevel);
  const { app, close } = createAsyncVendorApp({
    rateLimit: config.vendorRateLimit,
    rateWindowMs: config.vendorRateWindowMs,
    delayMs: config.asyncVendorDelayMs,
    webhookUrl: config.asyncWebhookUrl,
    webhookSecret: config.webhookSecret,
    webhookMaxRetries: config.webhookMaxRetries,
    webhookRetryBaseMs: config.webhookRetryBaseMs,
    webhookTimeoutMs: config.webhookTimeoutMs,
    log,
  });
  const server = app.listen(config.asyncVendorPort, () => {
    log.info('async_vendor_listening', { port: config.asyncVendorPort });
  });

  function shutdown() {
    close();
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

module.exports = {
  createAsyncVendorApp,
  startAsyncVendor,
};

if (require.main === module) {
  const { loadConfig } = require('../src/config');
  startAsyncVendor(loadConfig());
}
