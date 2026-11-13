'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/utils/logger');
const { createJobService } = require('../../src/services/job.service');
const { createApp } = require('../../src/app');
const { createRateLimiter } = require('../../src/services/rate-limiter.service');
const { publishPending, recoverStale } = require('../../src/services/outbox.publisher');
const { signBody } = require('../../src/services/webhook-auth.service');
const { isUuid } = require('../../src/utils/ids');
const { sleep } = require('../../src/utils/retry');
const { createSyncVendorApp } = require('../../vendor-mocks/sync-vendor');
const { createAsyncVendorApp } = require('../../vendor-mocks/async-vendor');
const { processDelivery } = require('../../worker/processor');
const { listen, request, createFakeChannel, jobMessage } = require('../helpers/http');

const ctx = {};

function allowAll() {
  return {
    async acquire() {},
    async tryAcquire() { return true; },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for a condition');
}

async function postJob(payload) {
  return request(`${ctx.api.url}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function deliver(requestId, options = {}) {
  const channel = options.channel || createFakeChannel();
  const result = await processDelivery({
    channel,
    msg: jobMessage(requestId),
    db: ctx.db,
    jobs: ctx.jobs,
    config: options.config || ctx.config,
    rateLimiter: options.rateLimiter || ctx.allowAll,
    log: ctx.log,
  });
  return { result, channel };
}

describe('multi-vendor flow', { concurrency: 1 }, () => {
  before(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    ctx.repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    ctx.client = new MongoClient(ctx.repl.getUri());
    await ctx.client.connect();
    ctx.db = ctx.client.db('vendor_fetch_test');
    ctx.log = createLogger('error');
    ctx.config = loadConfig({
      WEBHOOK_SECRET: 'test-secret-value',
      LOG_LEVEL: 'error',
      WORKER_MAX_ATTEMPTS: '5',
      WORKER_LEASE_MS: '15000',
      SYNC_VENDOR_TIMEOUT_MS: '2000',
      ASYNC_VENDOR_TIMEOUT_MS: '2000',
      RETRY_BASE_MS: '1000',
      RETRY_CAP_MS: '16000',
      OUTBOX_MAX_ATTEMPTS: '10',
      OUTBOX_LOCK_MS: '30000',
      PII_FIELDS: 'email,phone,ssn',
      VENDOR_RATE_LIMIT: '2',
      VENDOR_RATE_WINDOW_MS: '1000',
      RATE_LIMIT_MAX_WAIT_MS: '20000',
    });
    ctx.jobs = createJobService({ piiFields: ctx.config.piiFields });
    await ctx.jobs.ensureIndexes(ctx.db);
    ctx.allowAll = allowAll();

    const api = createApp({
      config: ctx.config,
      db: ctx.db,
      jobService: ctx.jobs,
      log: ctx.log,
    });
    ctx.api = await listen(api);

    ctx.syncVendor = createSyncVendorApp({
      rateLimit: 100,
      rateWindowMs: 1000,
      latencyMs: 0,
      timeoutDelayMs: 500,
      log: ctx.log,
    });
    ctx.sync = await listen(ctx.syncVendor.app);

    ctx.asyncVendor = createAsyncVendorApp({
      rateLimit: 100,
      rateWindowMs: 1000,
      delayMs: 80,
      webhookUrl: `${ctx.api.url}/vendor-webhook/async`,
      webhookSecret: ctx.config.webhookSecret,
      webhookMaxRetries: 5,
      webhookRetryBaseMs: 20,
      webhookTimeoutMs: 1000,
      log: ctx.log,
    });
    ctx.asyncHttp = await listen(ctx.asyncVendor.app);

    ctx.config.syncVendorUrl = ctx.sync.url;
    ctx.config.asyncVendorUrl = ctx.asyncHttp.url;
    ctx.config.asyncWebhookUrl = `${ctx.api.url}/vendor-webhook/async`;
  });

  after(async () => {
    if (ctx.asyncVendor) ctx.asyncVendor.close();
    if (ctx.api) await ctx.api.close();
    if (ctx.sync) await ctx.sync.close();
    if (ctx.asyncHttp) await ctx.asyncHttp.close();
    if (ctx.client) await ctx.client.close();
    if (ctx.repl) await ctx.repl.stop();
  });

  it('POST /jobs creates a pending job and returns a uuid', async () => {
    const created = await postJob({ vendor: 'sync', customer: '  Ada ', amount: 5 });
    assert.equal(created.status, 202);
    assert.equal(isUuid(created.body.request_id), true);
    assert.deepEqual(Object.keys(created.body), ['request_id']);

    const job = await ctx.jobs.getByRequestId(ctx.db, created.body.request_id);
    assert.equal(job.status, 'pending');
    assert.equal(job.vendor, 'sync');
    assert.equal(job.payload.customer, '  Ada ');
    const outbox = await ctx.db.collection('outbox').findOne({ request_id: created.body.request_id });
    assert.equal(outbox.status, 'pending');
    assert.equal(ctx.syncVendor.stats.requests, 0);
  });

  it('accepts arbitrary JSON and rejects malformed JSON or an unknown vendor', async () => {
    const primitive = await postJob(true);
    assert.equal(primitive.status, 202);

    const arrayPayload = await postJob([{ vendor: 'async' }]);
    assert.equal(arrayPayload.status, 202);
    const stored = await ctx.jobs.getByRequestId(ctx.db, arrayPayload.body.request_id);
    assert.equal(stored.vendor, 'sync');

    const malformed = await request(`${ctx.api.url}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"vendor":',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'invalid_json');

    const badVendor = await postJob({ vendor: 'stripe' });
    assert.equal(badVendor.status, 400);
    assert.equal(badVendor.body.error, 'invalid_vendor');

    const badId = await request(`${ctx.api.url}/jobs/not-a-uuid`);
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error, 'invalid_request_id');
  });

  it('GET returns processing, complete, failed, or 404', async () => {
    const created = await postJob({ vendor: 'sync', note: 'status' });
    const requestId = created.body.request_id;
    const pending = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body, { status: 'processing' });

    await ctx.db.collection('jobs').updateOne({ request_id: requestId }, { $set: { status: 'processing' } });
    const processing = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.deepEqual(processing.body, { status: 'processing' });

    await ctx.db.collection('jobs').updateOne(
      { request_id: requestId },
      { $set: { status: 'complete', result: { balance: 9, email: 'kept-if-already-stored' } } }
    );
    const complete = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.equal(complete.status, 200);
    assert.equal(complete.body.status, 'complete');
    assert.equal(complete.body.result.balance, 9);

    const failedId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, { requestId: failedId, payload: {}, vendor: 'sync' });
    await ctx.db.collection('jobs').updateOne(
      { request_id: failedId },
      { $set: { status: 'failed', error_code: 'max_retries_exceeded' } }
    );
    const failed = await request(`${ctx.api.url}/jobs/${failedId}`);
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body, { status: 'failed', error_code: 'max_retries_exceeded' });

    const missing = await request(`${ctx.api.url}/jobs/${crypto.randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'job_not_found');

    const reads = ctx.syncVendor.stats.requests;
    await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.equal(ctx.syncVendor.stats.requests, reads);
  });

  it('publishes the outbox once and can rebuild a missing outbox row', async () => {
    await ctx.db.collection('outbox').updateMany({ status: 'pending' }, { $set: { status: 'published' } });
    const created = await postJob({ vendor: 'sync', note: 'outbox' });
    const requestId = created.body.request_id;
    const channel = createFakeChannel();
    await publishPending({ db: ctx.db, channel, config: ctx.config, log: ctx.log });
    assert.equal(channel.events.length, 1);
    assert.equal(channel.events[0].queue, ctx.config.jobsQueue);
    assert.equal(channel.events[0].body.request_id, requestId);
    assert.equal((await ctx.db.collection('outbox').findOne({ request_id: requestId })).status, 'published');

    await publishPending({ db: ctx.db, channel, config: ctx.config, log: ctx.log });
    assert.equal(channel.events.length, 1);

    const orphanId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, { requestId: orphanId, payload: { vendor: 'sync' }, vendor: 'sync' });
    await ctx.db.collection('outbox').deleteOne({ request_id: orphanId });
    await ctx.db.collection('jobs').updateOne(
      { request_id: orphanId },
      { $set: { created_at: new Date(Date.now() - 10000) } }
    );
    await recoverStale(ctx.db, ctx.config);
    const repaired = await ctx.db.collection('outbox').findOne({ request_id: orphanId });
    assert.equal(repaired.status, 'pending');
  });

  it('marks the job failed when the broker cannot accept the outbox message', async () => {
    await ctx.db.collection('outbox').updateMany({ status: 'pending' }, { $set: { status: 'published' } });
    const created = await postJob({ vendor: 'sync', note: 'broker-down' });
    const channel = {
      sendToQueue() {
        throw new Error('amqp://vendor:vendor@rabbitmq:5672 connection reset');
      },
    };
    await publishPending({
      db: ctx.db,
      channel,
      config: { ...ctx.config, outboxMaxAttempts: 1 },
      log: ctx.log,
    });
    const job = await ctx.jobs.getByRequestId(ctx.db, created.body.request_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'queue_unavailable');
  });

  it('cleans a synchronous vendor result and acknowledges only after it is saved', async () => {
    const before = ctx.syncVendor.stats.requests;
    const created = await postJob({
      vendor: 'sync',
      account: '  Ada ',
    });
    const requestId = created.body.request_id;
    const first = await deliver(requestId);
    assert.equal(first.result.action, 'ack');
    assert.equal(first.channel.events.some((event) => event.type === 'nack'), false);

    const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(job.status, 'complete');
    assert.equal(job.result.account_name, 'Ada Lovelace');
    assert.equal(job.result.email, '[REDACTED]');
    assert.equal(job.result.phone, '[REDACTED]');
    assert.equal(job.result.ssn, '[REDACTED]');
    assert.equal(job.result.profile.city, 'London');
    assert.equal(job.result.profile.email, '[REDACTED]');
    assert.equal(job.result.tags[0], 'gold');
    assert.equal(job.result.balance, 42);
    assert.equal(job.result.note, null);
    assert.equal(ctx.syncVendor.stats.requests, before + 1);

    const view = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.equal(view.body.status, 'complete');
    assert.equal(view.body.result.email, '[REDACTED]');

    const second = await deliver(requestId);
    assert.equal(second.result.action, 'ack');
    assert.equal(ctx.syncVendor.stats.requests, before + 1);
  });

  it('keeps an async job processing until the signed webhook is stored', async () => {
    const slow = createAsyncVendorApp({
      rateLimit: 10,
      rateWindowMs: 1000,
      delayMs: 60000,
      webhookUrl: `${ctx.api.url}/vendor-webhook/async`,
      webhookSecret: ctx.config.webhookSecret,
      webhookMaxRetries: 1,
      webhookRetryBaseMs: 10,
      webhookTimeoutMs: 200,
      log: ctx.log,
    });
    const slowHttp = await listen(slow.app);
    const requestId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, {
      requestId,
      payload: { vendor: 'async', customer: 'Ada' },
      vendor: 'async',
    });
    try {
      const held = await deliver(requestId, {
        config: { ...ctx.config, asyncVendorUrl: slowHttp.url },
      });
      assert.equal(held.result.action, 'ack');
      const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
      assert.equal(job.status, 'processing');
      assert.equal(typeof job.vendor_job_id, 'string');
      assert.equal(job.result, null);
      const view = await request(`${ctx.api.url}/jobs/${requestId}`);
      assert.deepEqual(view.body, { status: 'processing' });
    } finally {
      slow.close();
      await slowHttp.close();
    }
  });

  it('completes the original async job from the webhook and ignores duplicates', async () => {
    const created = await postJob({ vendor: 'async', customer: 'Grace' });
    const requestId = created.body.request_id;
    await deliver(requestId);
    await waitFor(async () => {
      const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
      return job.status === 'complete';
    });
    const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(job.result.email, '[REDACTED]');
    assert.equal(job.result.account_name, 'Ada Lovelace');
    const view = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.equal(view.body.status, 'complete');

    const raw = JSON.stringify({
      request_id: requestId,
      vendor_job_id: job.vendor_job_id,
      status: 'success',
      result: { account_name: 'changed', email: 'other@example.com', balance: 1 },
    });
    const duplicate = await request(`${ctx.api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': signBody(Buffer.from(raw), ctx.config.webhookSecret),
      },
      body: raw,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, 'duplicate');
    const again = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(again.result.account_name, 'Ada Lovelace');
    assert.equal(again.result.balance, 42);
  });

  it('rejects an invalid webhook signature and a mismatched vendor job id', async () => {
    const requestId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, { requestId, payload: { vendor: 'async' }, vendor: 'async' });
    await ctx.db.collection('jobs').updateOne(
      { request_id: requestId },
      { $set: { status: 'processing', vendor_job_id: 'vendor-a' } }
    );
    const raw = JSON.stringify({
      request_id: requestId,
      vendor_job_id: 'vendor-a',
      status: 'success',
      result: { balance: 3, email: 'ada@example.com' },
    });
    const rejected = await request(`${ctx.api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': signBody(Buffer.from(raw), 'wrong-secret'),
      },
      body: raw,
    });
    assert.equal(rejected.status, 401);
    const unchanged = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(unchanged.status, 'processing');
    assert.equal(unchanged.result, null);

    const mismatch = JSON.stringify({
      request_id: requestId,
      vendor_job_id: 'vendor-b',
      status: 'success',
      result: { balance: 3 },
    });
    const conflict = await request(`${ctx.api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': signBody(Buffer.from(mismatch), ctx.config.webhookSecret),
      },
      body: mismatch,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await ctx.jobs.getByRequestId(ctx.db, requestId)).status, 'processing');

    const unknown = JSON.stringify({
      request_id: crypto.randomUUID(),
      vendor_job_id: 'vendor-z',
      status: 'success',
      result: { balance: 1 },
    });
    const missing = await request(`${ctx.api.url}/vendor-webhook/async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vendor-signature': signBody(Buffer.from(unknown), ctx.config.webhookSecret),
      },
      body: unknown,
    });
    assert.equal(missing.status, 404);
  });

  it('applies one result when the same webhook arrives twice at once', async () => {
    const requestId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, { requestId, payload: { vendor: 'async' }, vendor: 'async' });
    await ctx.db.collection('jobs').updateOne(
      { request_id: requestId },
      { $set: { status: 'processing', vendor_job_id: 'vendor-same' } }
    );
    const raw = JSON.stringify({
      request_id: requestId,
      vendor_job_id: 'vendor-same',
      status: 'success',
      result: { balance: 8, email: 'ada@example.com', name: '  Grace ' },
    });
    const headers = {
      'content-type': 'application/json',
      'x-vendor-signature': signBody(Buffer.from(raw), ctx.config.webhookSecret),
    };
    const [first, second] = await Promise.all([
      request(`${ctx.api.url}/vendor-webhook/async`, { method: 'POST', headers, body: raw }),
      request(`${ctx.api.url}/vendor-webhook/async`, { method: 'POST', headers, body: raw }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(job.status, 'complete');
    assert.equal(job.result.email, '[REDACTED]');
    assert.equal(job.result.name, 'Grace');
    assert.equal(job.result.balance, 8);
  });

  it('marks an async vendor failure from the webhook without calling it complete', async () => {
    const created = await postJob({ vendor: 'async', scenario: 'fail' });
    const requestId = created.body.request_id;
    const handled = await deliver(requestId);
    assert.equal(handled.result.action, 'ack');
    const immediate = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(immediate.status, 'processing');
    await waitFor(async () => (await ctx.jobs.getByRequestId(ctx.db, requestId)).status === 'failed');
    const failed = await request(`${ctx.api.url}/jobs/${requestId}`);
    assert.deepEqual(failed.body, { status: 'failed', error_code: 'vendor_rejected' });
  });

  it('retries 429 and timeouts, and fails malformed responses without looping', async () => {
    const rateId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, {
      requestId: rateId,
      payload: { vendor: 'sync', scenario: 'rate_limit' },
      vendor: 'sync',
    });
    const rate = await deliver(rateId);
    assert.equal(rate.result.action, 'retry');
    assert.equal(rate.result.queue, 'jobs.retry.1000');
    assert.equal((await ctx.jobs.getByRequestId(ctx.db, rateId)).status, 'processing');

    const timeoutId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, {
      requestId: timeoutId,
      payload: { vendor: 'sync', scenario: 'timeout' },
      vendor: 'sync',
    });
    const timedOut = await deliver(timeoutId, {
      config: { ...ctx.config, syncVendorTimeoutMs: 150 },
    });
    assert.equal(timedOut.result.action, 'retry');
    assert.notEqual((await ctx.jobs.getByRequestId(ctx.db, timeoutId)).status, 'failed');

    const badId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, {
      requestId: badId,
      payload: { vendor: 'sync', scenario: 'malformed' },
      vendor: 'sync',
    });
    const malformed = await deliver(badId);
    assert.equal(malformed.result.action, 'dlq');
    assert.equal(malformed.channel.events.some((event) => event.type === 'publish'), false);
    assert.equal(malformed.channel.events.some((event) => event.type === 'nack' && event.requeue === false), true);
    const badJob = await ctx.jobs.getByRequestId(ctx.db, badId);
    assert.equal(badJob.status, 'failed');
    assert.equal(badJob.error_code, 'invalid_vendor_response');
  });

  it('stops after the configured number of transient failures', async () => {
    const requestId = crypto.randomUUID();
    await ctx.jobs.createJob(ctx.db, {
      requestId,
      payload: { vendor: 'sync', scenario: 'server_error' },
      vendor: 'sync',
    });
    const limited = { ...ctx.config, workerMaxAttempts: 2 };
    const before = ctx.syncVendor.stats.errors;
    const first = await deliver(requestId, { config: limited });
    assert.equal(first.result.action, 'retry');
    const second = await deliver(requestId, { config: limited });
    assert.equal(second.result.action, 'dlq');
    assert.equal(second.channel.events.some((event) => event.type === 'nack' && event.requeue === false), true);
    const job = await ctx.jobs.getByRequestId(ctx.db, requestId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'max_retries_exceeded');
    assert.equal(job.attempts, 2);
    assert.equal(ctx.syncVendor.stats.errors, before + 2);

    const third = await deliver(requestId, { config: limited });
    assert.equal(third.result.action, 'ack');
    assert.equal(ctx.syncVendor.stats.errors, before + 2);
  });

  it('shares one rolling window across concurrent callers', async () => {
    const burst = createRateLimiter(ctx.db, { limit: 2, windowMs: 10000, maxWaitMs: 1000 });
    const flags = await Promise.all(Array.from({ length: 20 }, () => burst.tryAcquire('burst-vendor')));
    assert.equal(flags.filter(Boolean).length, 2);

    const sliding = createRateLimiter(ctx.db, { limit: 2, windowMs: 1000, maxWaitMs: 15000 });
    const times = [];
    await Promise.all(Array.from({ length: 6 }, async () => {
      await sliding.acquire('sliding-vendor');
      times.push(Date.now());
    }));
    times.sort((left, right) => left - right);
    assert.equal(times.length, 6);
    for (const time of times) {
      const inWindow = times.filter((stamp) => stamp > time - 1000 && stamp <= time);
      assert.ok(inWindow.length <= 2, `window contained ${inWindow.length} grants`);
    }
  });
});
