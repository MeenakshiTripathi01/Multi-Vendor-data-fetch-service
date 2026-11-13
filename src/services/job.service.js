'use strict';

const crypto = require('crypto');
const { unwrapFindAndModify } = require('../db/mongo');
const { cleanResponse } = require('./cleaner.service');
const { sanitizeErrorCode } = require('../utils/errors');

function isNoTransactionSupport(err) {
  const message = String(err && err.message ? err.message : '');
  return err.code === 20
    || /replica set member or mongos/i.test(message)
    || /Transaction numbers are only allowed/i.test(message);
}

function createJobService(options = {}) {
  const piiFields = options.piiFields || ['email', 'phone', 'ssn'];

  async function ensureIndexes(db) {
    await db.collection('jobs').createIndex({ request_id: 1 }, { unique: true });
    await db.collection('jobs').createIndex({ status: 1, updated_at: 1 });
    await db.collection('jobs').createIndex({ vendor_job_id: 1 });
    await db.collection('outbox').createIndex({ request_id: 1 }, { unique: true });
    await db.collection('outbox').createIndex({ status: 1, next_attempt_at: 1 });
  }

  async function createJob(db, { requestId, payload, vendor }) {
    const now = new Date();
    const job = {
      request_id: requestId,
      payload,
      vendor,
      status: 'pending',
      result: null,
      error_code: null,
      attempts: 0,
      vendor_job_id: null,
      lock_token: null,
      lease_until: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    const event = {
      request_id: requestId,
      status: 'pending',
      attempts: 0,
      created_at: now,
      next_attempt_at: now,
      published_at: null,
      locked_at: null,
    };

    const session = db.client.startSession();
    try {
      let wroteInTransaction = false;
      try {
        await session.withTransaction(async () => {
          await db.collection('jobs').insertOne({ ...job }, { session });
          await db.collection('outbox').insertOne({ ...event }, { session });
        });
        wroteInTransaction = true;
      } catch (err) {
        if (!isNoTransactionSupport(err)) throw err;
      }

      // Fallback for a standalone MongoDB. Insert the job first, then the
      // outbox row. If the process dies between the two writes, the publisher
      // reconciliation creates the missing outbox row. If the outbox insert
      // fails immediately, the job row is removed so the client can retry.
      if (!wroteInTransaction) {
        await db.collection('jobs').insertOne(job);
        try {
          await db.collection('outbox').insertOne(event);
        } catch (outboxErr) {
          await db.collection('jobs').deleteOne({ request_id: requestId });
          throw outboxErr;
        }
      }
      return job;
    } finally {
      await session.endSession();
    }
  }

  async function getByRequestId(db, requestId) {
    return db.collection('jobs').findOne({ request_id: requestId });
  }

  // Claim a job that nobody currently holds. The lease stops a second
  // delivery from calling the vendor while the first delivery is in flight.
  async function claim(db, requestId, leaseMs) {
    const now = new Date();
    const token = crypto.randomUUID();
    const raw = await db.collection('jobs').findOneAndUpdate(
      {
        request_id: requestId,
        status: { $in: ['pending', 'processing'] },
        $or: [
          { lease_until: null },
          { lease_until: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'processing',
          lock_token: token,
          lease_until: new Date(now.getTime() + leaseMs),
          updated_at: now,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' }
    );
    return unwrapFindAndModify(raw);
  }

  async function markComplete(db, requestId, lockToken, result) {
    const now = new Date();
    const updated = await db.collection('jobs').updateOne(
      { request_id: requestId, lock_token: lockToken, status: 'processing' },
      {
        $set: {
          status: 'complete',
          result,
          error_code: null,
          updated_at: now,
          completed_at: now,
          lease_until: null,
        },
      }
    );
    return updated.modifiedCount === 1;
  }

  async function markFailed(db, requestId, lockToken, errorCode) {
    const now = new Date();
    const filter = {
      request_id: requestId,
      status: { $in: ['pending', 'processing'] },
    };
    if (lockToken) filter.lock_token = lockToken;
    const updated = await db.collection('jobs').updateOne(
      filter,
      {
        $set: {
          status: 'failed',
          error_code: sanitizeErrorCode(errorCode),
          updated_at: now,
          completed_at: now,
          lease_until: null,
        },
      }
    );
    return updated.modifiedCount === 1;
  }

  // Records the async acknowledgement only. Status stays `processing`.
  async function saveVendorSubmission(db, requestId, lockToken, vendorJobId) {
    const now = new Date();
    const updated = await db.collection('jobs').updateOne(
      { request_id: requestId, lock_token: lockToken, status: 'processing' },
      {
        $set: {
          vendor_job_id: vendorJobId,
          updated_at: now,
          lease_until: null,
        },
      }
    );
    return updated.modifiedCount === 1;
  }

  async function releaseLease(db, requestId, lockToken) {
    await db.collection('jobs').updateOne(
      { request_id: requestId, lock_token: lockToken, status: 'processing' },
      { $set: { lease_until: new Date(0), updated_at: new Date() } }
    );
  }

  async function applyWebhook(db, { requestId, vendorJobId, status, result, errorCode }) {
    const job = await getByRequestId(db, requestId);
    if (!job) return { type: 'not_found' };
    if (job.vendor !== 'async') return { type: 'conflict' };
    if (job.vendor_job_id && vendorJobId && job.vendor_job_id !== vendorJobId) {
      return { type: 'conflict' };
    }
    // First terminal write wins. A repeated callback is a success for the
    // vendor (so it stops retrying) and a no-op for stored state.
    if (job.status === 'complete' || job.status === 'failed') return { type: 'duplicate' };

    const now = new Date();
    if (status === 'success') {
      const cleaned = cleanResponse(result, piiFields);
      const updated = await db.collection('jobs').updateOne(
        { request_id: requestId, status: { $in: ['pending', 'processing'] } },
        {
          $set: {
            status: 'complete',
            result: cleaned,
            vendor_job_id: vendorJobId || job.vendor_job_id,
            error_code: null,
            updated_at: now,
            completed_at: now,
            lease_until: null,
          },
        }
      );
      if (updated.modifiedCount === 1) return { type: 'completed' };
      const current = await getByRequestId(db, requestId);
      if (current && (current.status === 'complete' || current.status === 'failed')) return { type: 'duplicate' };
      return { type: 'conflict' };
    }

    if (status === 'failed') {
      const updated = await db.collection('jobs').updateOne(
        { request_id: requestId, status: { $in: ['pending', 'processing'] } },
        {
          $set: {
            status: 'failed',
            error_code: sanitizeErrorCode(errorCode),
            vendor_job_id: vendorJobId || job.vendor_job_id,
            updated_at: now,
            completed_at: now,
            lease_until: null,
          },
        }
      );
      if (updated.modifiedCount === 1) return { type: 'failed' };
      return { type: 'duplicate' };
    }

    return { type: 'invalid_payload' };
  }

  return {
    ensureIndexes,
    createJob,
    getByRequestId,
    claim,
    markComplete,
    markFailed,
    saveVendorSubmission,
    releaseLease,
    applyWebhook,
  };
}

module.exports = {
  createJobService,
};
