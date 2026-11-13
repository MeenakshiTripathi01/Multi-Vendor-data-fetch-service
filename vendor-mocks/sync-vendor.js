'use strict';

const express = require('express');
const { createLogger } = require('../src/utils/logger');
const { sleep } = require('../src/utils/retry');
const { createSlidingWindowLimiter } = require('./sliding-window');
const { buildVendorRecord } = require('./sample-data');

function retryAfterSeconds(retryAfterMs) {
  return String(Math.max(1, Math.ceil((retryAfterMs || 1000) / 1000)));
}

function createSyncVendorApp(options) {
  const log = options.log || createLogger('info');
  const limiter = createSlidingWindowLimiter({
    limit: options.rateLimit,
    windowMs: options.rateWindowMs,
  });
  const stats = { requests: 0, limited: 0, success: 0, errors: 0 };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ strict: false, limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/stats', (req, res) => {
    res.json(stats);
  });

  app.post('/vendor/fetch', async (req, res) => {
    stats.requests += 1;
    const decision = limiter.tryTake();
    if (!decision.allowed) {
      stats.limited += 1;
      res.set('Retry-After', retryAfterSeconds(decision.retryAfterMs));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const scenario = req.body && typeof req.body.scenario === 'string' ? req.body.scenario : 'success';
    if (scenario === 'rate_limit') {
      stats.errors += 1;
      res.set('Retry-After', '1');
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if (scenario === 'server_error') {
      stats.errors += 1;
      res.status(500).json({ error: 'vendor_unavailable' });
      return;
    }
    if (scenario === 'malformed') {
      stats.errors += 1;
      res.status(200).type('text/plain').send('not-json');
      return;
    }
    if (scenario === 'timeout') {
      await sleep(options.timeoutDelayMs);
    } else if (options.latencyMs > 0) {
      await sleep(options.latencyMs);
    }

    const requestId = req.body && typeof req.body.request_id === 'string' ? req.body.request_id : 'unknown';
    stats.success += 1;
    log.info('sync_vendor_response', { request_id: requestId });
    res.json(buildVendorRecord(requestId));
  });

  return { app, stats };
}

function startSyncVendor(config) {
  const log = createLogger(config.logLevel);
  const { app } = createSyncVendorApp({
    rateLimit: config.vendorRateLimit,
    rateWindowMs: config.vendorRateWindowMs,
    latencyMs: config.syncVendorLatencyMs,
    timeoutDelayMs: config.syncVendorTimeoutDelayMs,
    log,
  });
  const server = app.listen(config.syncVendorPort, () => {
    log.info('sync_vendor_listening', { port: config.syncVendorPort });
  });
  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

module.exports = {
  createSyncVendorApp,
  startSyncVendor,
};

if (require.main === module) {
  const { loadConfig } = require('../src/config');
  startSyncVendor(loadConfig());
}
