'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { isUuid, selectVendor, toPublicView } = require('../../src/utils/ids');
const { sanitizeErrorCode } = require('../../src/utils/errors');
const { computeBackoffMs, pickRetryQueue, parseRetryAfterMs } = require('../../src/utils/retry');
const { signBody, verifySignature } = require('../../src/services/webhook-auth.service');
const { createSlidingWindowLimiter } = require('../../vendor-mocks/sliding-window');

describe('request validation helpers', () => {
  it('accepts uuid v4 values and rejects everything else', () => {
    assert.equal(isUuid(crypto.randomUUID()), true);
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid(''), false);
    assert.equal(isUuid(undefined), false);
  });

  it('selects a known vendor and rejects an unknown one', () => {
    assert.equal(selectVendor({ vendor: 'async' }, {}), 'async');
    assert.equal(selectVendor({ vendor: 'sync' }, { vendor: 'async' }), 'async');
    assert.equal(selectVendor({ amount: 1 }, {}), 'sync');
    assert.equal(selectVendor(['async'], {}), 'sync');
    assert.equal(selectVendor({ vendor: 'other' }, {}), null);
  });

  it('maps stored statuses to the public response', () => {
    assert.deepEqual(toPublicView({ status: 'pending' }, sanitizeErrorCode), {
      http: 200,
      body: { status: 'processing' },
    });
    assert.deepEqual(toPublicView({ status: 'processing' }, sanitizeErrorCode), {
      http: 200,
      body: { status: 'processing' },
    });
    assert.deepEqual(toPublicView({ status: 'complete', result: { ok: true } }, sanitizeErrorCode), {
      http: 200,
      body: { status: 'complete', result: { ok: true } },
    });
    const failed = toPublicView({ status: 'failed', error_code: 'drop table' }, sanitizeErrorCode);
    assert.equal(failed.body.error_code, 'vendor_unavailable');
    assert.equal(failed.body.status, 'failed');
    assert.equal(Object.hasOwn(failed.body, 'result'), false);
  });
});

describe('retry timing', () => {
  it('backs off exponentially and picks a delay queue', () => {
    assert.equal(computeBackoffMs(1, { baseMs: 1000, capMs: 16000 }), 1000);
    assert.equal(computeBackoffMs(2, { baseMs: 1000, capMs: 16000 }), 2000);
    assert.equal(computeBackoffMs(3, { baseMs: 1000, capMs: 16000 }), 4000);
    assert.equal(computeBackoffMs(10, { baseMs: 1000, capMs: 16000 }), 16000);
    assert.deepEqual(pickRetryQueue('jobs', 1000), { queue: 'jobs.retry.1000', delayMs: 1000 });
    assert.deepEqual(pickRetryQueue('jobs', 1500), { queue: 'jobs.retry.2000', delayMs: 2000 });
    assert.deepEqual(pickRetryQueue('jobs', 60000), { queue: 'jobs.retry.16000', delayMs: 16000 });
  });

  it('parses Retry-After seconds', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    assert.equal(parseRetryAfterMs('0'), 0);
    assert.equal(parseRetryAfterMs('nope'), null);
  });
});

describe('webhook signatures', () => {
  it('accepts the raw body and rejects tampering', () => {
    const raw = Buffer.from('{"request_id":"abc"}');
    const signature = signBody(raw, 'test-secret-value');
    assert.equal(verifySignature(raw, signature, 'test-secret-value'), true);
    assert.equal(verifySignature(Buffer.from('{"request_id":"zzz"}'), signature, 'test-secret-value'), false);
    assert.equal(verifySignature(raw, signature, 'other-secret'), false);
    assert.equal(verifySignature(raw, 'sha256=abcd', 'test-secret-value'), false);
    assert.equal(verifySignature(raw, undefined, 'test-secret-value'), false);
  });
});

describe('mock vendor sliding window', () => {
  it('allows at most two calls in any rolling one-second window', () => {
    let now = 10000;
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, now: () => now });

    assert.equal(limiter.tryTake().allowed, true);
    assert.equal(limiter.tryTake().allowed, true);
    assert.equal(limiter.tryTake().allowed, false);

    now = 10999;
    assert.equal(limiter.tryTake().allowed, false);

    now = 11000;
    assert.equal(limiter.tryTake().allowed, true);
    assert.equal(limiter.tryTake().allowed, true);
    assert.equal(limiter.tryTake().allowed, false);
  });

  it('rejects a burst at the same timestamp after two grants', () => {
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, now: () => 5000 });
    const results = Array.from({ length: 10 }, () => limiter.tryTake().allowed);
    assert.equal(results.filter(Boolean).length, 2);
  });
});
