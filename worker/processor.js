'use strict';

const { classifyVendorFailure } = require('../src/utils/errors');
const { computeBackoffMs, pickRetryQueue } = require('../src/utils/retry');
const { publishConfirmed } = require('../src/services/queue.service');
const { callSyncVendor, callAsyncVendor } = require('../src/services/vendor.service');
const { cleanResponse } = require('../src/services/cleaner.service');

// Crash behaviour:
// Manual acks are sent only after the durable outcome is in MongoDB.
// If the process dies after the vendor responds and before ack, RabbitMQ
// redelivers the same message.
// - A job already marked complete or failed is acknowledged with no vendor call.
// - An async job that already has vendor_job_id stays processing and is
//   acknowledged. The webhook is what completes it.
// - If the crash happened before that write, the delivery runs again. The
//   sync vendor can therefore be called more than once. lock_token updates
//   refuse to overwrite a newer terminal state.

async function deferMessage(channel, msg, config, requestId, delayMs) {
  const target = pickRetryQueue(config.jobsQueue, delayMs);
  await publishConfirmed(channel, target.queue, { request_id: requestId });
  channel.ack(msg);
  return { action: 'retry', delay_ms: target.delayMs, queue: target.queue };
}

async function acknowledgeIfSettled(channel, msg, jobs, db, requestId) {
  const current = await jobs.getByRequestId(db, requestId);
  if (!current) {
    channel.ack(msg);
    return { action: 'ack' };
  }
  if (current.status === 'complete' || current.status === 'failed') {
    channel.ack(msg);
    return { action: 'ack' };
  }
  if (current.vendor === 'async' && current.vendor_job_id) {
    channel.ack(msg);
    return { action: 'ack' };
  }
  return null;
}

async function processDelivery({ channel, msg, db, jobs, config, rateLimiter, log }) {
  let body;
  try {
    body = JSON.parse(msg.content.toString('utf8'));
  } catch {
    log.error('job_message_malformed', {});
    channel.nack(msg, false, false);
    return { action: 'dlq' };
  }

  const requestId = body && body.request_id;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    log.error('job_message_missing_id', {});
    channel.nack(msg, false, false);
    return { action: 'dlq' };
  }

  const job = await jobs.getByRequestId(db, requestId);
  if (!job) {
    log.error('job_message_unknown', { request_id: requestId });
    channel.ack(msg);
    return { action: 'ack' };
  }

  const settled = await acknowledgeIfSettled(channel, msg, jobs, db, requestId);
  if (settled) return settled;

  const claim = await jobs.claim(db, requestId, config.workerLeaseMs);
  if (!claim) {
    const alreadySettled = await acknowledgeIfSettled(channel, msg, jobs, db, requestId);
    if (alreadySettled) return alreadySettled;
    log.info('job_lease_held', { request_id: requestId });
    return deferMessage(channel, msg, config, requestId, 1000);
  }

  if (claim.vendor !== 'sync' && claim.vendor !== 'async') {
    await jobs.markFailed(db, requestId, claim.lock_token, 'vendor_rejected');
    channel.nack(msg, false, false);
    log.error('job_failed', { request_id: requestId, error_code: 'vendor_rejected' });
    return { action: 'dlq' };
  }

  // attempts was incremented by the claim. A previous try that already hit
  // the cap (and then crashed before recording failure) stops here.
  if (claim.attempts > config.workerMaxAttempts) {
    await jobs.markFailed(db, requestId, claim.lock_token, 'max_retries_exceeded');
    channel.nack(msg, false, false);
    log.error('job_retries_exhausted', { request_id: requestId, attempts: claim.attempts });
    return { action: 'dlq' };
  }

  try {
    await rateLimiter.acquire(claim.vendor);

    if (claim.vendor === 'sync') {
      const raw = await callSyncVendor(config, claim);
      const cleaned = cleanResponse(raw, config.piiFields);
      const saved = await jobs.markComplete(db, requestId, claim.lock_token, cleaned);
      if (!saved) return recoverLostLock(channel, msg, jobs, db, config, requestId, log);
      channel.ack(msg);
      log.info('job_complete', { request_id: requestId, vendor: 'sync' });
      return { action: 'ack' };
    }

    const accepted = await callAsyncVendor(config, claim);
    const saved = await jobs.saveVendorSubmission(db, requestId, claim.lock_token, accepted.vendor_job_id);
    if (!saved) return recoverLostLock(channel, msg, jobs, db, config, requestId, log);
    // The acknowledgement is not completion. The webhook writes the result.
    channel.ack(msg);
    log.info('async_vendor_accepted', { request_id: requestId, vendor: 'async' });
    return { action: 'ack' };
  } catch (err) {
    const failure = classifyVendorFailure(err);
    const exhausted = !failure.permanent && claim.attempts >= config.workerMaxAttempts;
    if (failure.permanent || exhausted) {
      const errorCode = exhausted ? 'max_retries_exceeded' : failure.errorCode;
      const saved = await jobs.markFailed(db, requestId, claim.lock_token, errorCode);
      if (!saved) return recoverLostLock(channel, msg, jobs, db, config, requestId, log);
      channel.nack(msg, false, false);
      log.error('job_failed', { request_id: requestId, error_code: errorCode, attempts: claim.attempts });
      return { action: 'dlq' };
    }

    const backoff = computeBackoffMs(claim.attempts, {
      baseMs: config.retryBaseMs,
      capMs: config.retryCapMs,
    });
    const delay = Math.max(backoff, failure.retryAfterMs || 0);
    await jobs.releaseLease(db, requestId, claim.lock_token);
    const scheduled = await deferMessage(channel, msg, config, requestId, delay);
    log.info('job_retry_scheduled', {
      request_id: requestId,
      attempts: claim.attempts,
      delay_ms: scheduled.delay_ms,
      error_code: failure.errorCode,
    });
    return scheduled;
  }
}

async function recoverLostLock(channel, msg, jobs, db, config, requestId, log) {
  const settled = await acknowledgeIfSettled(channel, msg, jobs, db, requestId);
  if (settled) return settled;
  log.info('job_lock_lost', { request_id: requestId });
  return deferMessage(channel, msg, config, requestId, 1000);
}

module.exports = {
  processDelivery,
};
