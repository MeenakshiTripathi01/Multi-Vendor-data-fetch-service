'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/utils/logger');
const { createApp } = require('../../src/app');
const { signBody } = require('../../src/services/webhook-auth.service');
const { createSyncVendorApp } = require('../../vendor-mocks/sync-vendor');
const { createAsyncVendorApp } = require('../../vendor-mocks/async-vendor');
const { postJson } = require('../../src/utils/http');
const { listen, request } = require('../helpers/http');

const log = createLogger('error');
const secret = 'test-secret-value';
const servers = [];

async function start(app) {
  const running = await listen(app);
  servers.push(running);
  return running;
}

after(async () => {
  while (servers.length > 0) {
    const running = servers.pop();
    await running.close();
  }
});

describe('mock vendors', () => {
  it('returns deterministic sync data, then 500, malformed text, and timeout', async () => {
    const { app } = createSyncVendorApp({
      rateLimit: 100,
      rateWindowMs: 1000,
      latencyMs: 0,
      timeoutDelayMs: 400,
      log,
    });
    const vendor = await start(app);
    const requestId = crypto.randomUUID();

    const success = await request(`${vendor.url}/vendor/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, scenario: 'success' }),
    });
    assert.equal(success.status, 200);
    assert.equal(success.body.vendor_reference, requestId);
    assert.equal(success.body.email, 'ada@example.com');
    assert.equal(success.body.balance, 42);

    const failure = await request(`${vendor.url}/vendor/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, scenario: 'server_error' }),
    });
    assert.equal(failure.status, 500);

    const malformed = await request(`${vendor.url}/vendor/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, scenario: 'malformed' }),
    });
    assert.equal(malformed.status, 200);
    assert.equal(malformed.text, 'not-json');

    await assert.rejects(
      () => postJson(`${vendor.url}/vendor/fetch`, { request_id: requestId, scenario: 'timeout' }, 80),
      (err) => err.name === 'AbortError'
    );
  });

  it('returns 429 once the sync vendor sliding window is full', async () => {
    const { app } = createSyncVendorApp({
      rateLimit: 2,
      rateWindowMs: 1000,
      latencyMs: 0,
      timeoutDelayMs: 50,
      log,
    });
    const vendor = await start(app);
    const calls = await Promise.all(Array.from({ length: 5 }, () => request(`${vendor.url}/vendor/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: crypto.randomUUID() }),
    })));
    const allowed = calls.filter((call) => call.status === 200);
    const limited = calls.filter((call) => call.status === 429);
    assert.equal(allowed.length, 2);
    assert.equal(limited.length, 3);
    assert.ok(limited.every((call) => call.headers.get('retry-after')));
  });

  it('acknowledges an async job without a result and retries the webhook', async () => {
    let attempts = 0;
    const receiver = await start((() => {
      const express = require('express');
      const app = express();
      app.post('/hook', (req, res) => {
        attempts += 1;
        if (attempts < 3) {
          res.status(500).json({ error: 'unavailable' });
          return;
        }
        res.status(200).json({ status: 'complete' });
      });
      return app;
    })());

    const { app, close } = createAsyncVendorApp({
      rateLimit: 10,
      rateWindowMs: 1000,
      delayMs: 20,
      webhookUrl: `${receiver.url}/hook`,
      webhookSecret: secret,
      webhookMaxRetries: 5,
      webhookRetryBaseMs: 10,
      webhookTimeoutMs: 1000,
      log,
    });
    const vendor = await start(app);
    try {
      const requestId = crypto.randomUUID();
      const accepted = await request(`${vendor.url}/vendor/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, webhook_url: `${receiver.url}/hook` }),
      });
      assert.equal(accepted.status, 202);
      assert.equal(typeof accepted.body.vendor_job_id, 'string');
      assert.equal(Object.hasOwn(accepted.body, 'result'), false);

      const again = await request(`${vendor.url}/vendor/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: requestId }),
      });
      assert.equal(again.body.vendor_job_id, accepted.body.vendor_job_id);

      const deadline = Date.now() + 3000;
      while (attempts < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(attempts, 3);
    } finally {
      close();
    }
  });

  it('rate limits async submissions', async () => {
    const { app, close } = createAsyncVendorApp({
      rateLimit: 2,
      rateWindowMs: 1000,
      delayMs: 60000,
      webhookUrl: 'http://127.0.0.1:9/unused',
      webhookSecret: secret,
      webhookMaxRetries: 1,
      webhookRetryBaseMs: 10,
      webhookTimeoutMs: 50,
      log,
    });
    const vendor = await start(app);
    try {
      const calls = await Promise.all(Array.from({ length: 5 }, () => request(`${vendor.url}/vendor/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: crypto.randomUUID() }),
      })));
      assert.equal(calls.filter((call) => call.status === 202).length, 2);
      assert.equal(calls.filter((call) => call.status === 429).length, 3);
    } finally {
      close();
    }
  });
});

describe('webhook route failures', () => {
  it('returns 500 when persistence throws so the vendor can retry', async () => {
    const config = loadConfig({ WEBHOOK_SECRET: secret, LOG_LEVEL: 'error' });
    let calls = 0;
    const app = createApp({
      config,
      db: { async command() { return { ok: 1 }; } },
      jobService: {
        async applyWebhook() {
          calls += 1;
          throw new Error('database unavailable');
        },
      },
      log,
    });
    const api = await start(app);
    const payload = {
      request_id: crypto.randomUUID(),
      vendor_job_id: 'vendor-1',
      status: 'success',
      result: { balance: 1 },
    };
    const raw = JSON.stringify(payload);
    const response = await request(`${api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': signBody(Buffer.from(raw), secret),
      },
      body: raw,
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'unavailable');
    assert.equal(calls, 1);
  });

  it('rejects a bad signature before touching the job', async () => {
    const config = loadConfig({ WEBHOOK_SECRET: secret, LOG_LEVEL: 'error' });
    let calls = 0;
    const app = createApp({
      config,
      db: { async command() { return { ok: 1 }; } },
      jobService: {
        async applyWebhook() {
          calls += 1;
          return { type: 'completed' };
        },
      },
      log,
    });
    const api = await start(app);
    const response = await request(`${api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': 'sha256=deadbeef',
      },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        status: 'success',
        result: { balance: 1 },
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'invalid_signature');
    assert.equal(calls, 0);
  });
});
