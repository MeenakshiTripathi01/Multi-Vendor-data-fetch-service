'use strict';

const { computeBackoffMs } = require('../utils/retry');
const { publishConfirmed } = require('./queue.service');
const { safeError } = require('../utils/logger');
const { sanitizeErrorCode } = require('../utils/errors');

// Publishes outbox rows to RabbitMQ. The HTTP handler does not publish
// directly: the job and the outbox row commit together in MongoDB, and this
// loop retries until the broker confirms the message. A crash after the
// confirm and before `published` is written can send a duplicate message.
// The worker treats a duplicate as the same job.

async function recoverStale(db, config) {
  const staleBefore = new Date(Date.now() - config.outboxLockMs);
  await db.collection('outbox').updateMany(
    { status: 'publishing', locked_at: { $lt: staleBefore } },
    { $set: { status: 'pending', locked_at: null }, $inc: { attempts: 1 } }
  );

  const cutoff = new Date(Date.now() - 5000);
  const orphans = await db.collection('jobs')
    .find({ status: 'pending', created_at: { $lt: cutoff } })
    .limit(50)
    .toArray();

  for (const job of orphans) {
    try {
      await db.collection('outbox').updateOne(
        { request_id: job.request_id },
        {
          $setOnInsert: {
            request_id: job.request_id,
            status: 'pending',
            attempts: 0,
            created_at: new Date(),
            next_attempt_at: new Date(),
            published_at: null,
            locked_at: null,
          },
        },
        { upsert: true }
      );
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
  }
}

async function claimBatch(db, limit) {
  const claimed = [];
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const raw = await db.collection('outbox').findOneAndUpdate(
      { status: 'pending', next_attempt_at: { $lte: now } },
      { $set: { status: 'publishing', locked_at: now } },
      { sort: { created_at: 1 }, returnDocument: 'after' }
    );
    const row = raw && raw.lastErrorObject ? raw.value : raw;
    if (!row) break;
    claimed.push(row);
  }
  return claimed;
}

async function publishPending({ db, channel, config, log }) {
  await recoverStale(db, config);
  const batch = await claimBatch(db, 20);
  for (const row of batch) {
    try {
      await publishConfirmed(channel, config.jobsQueue, { request_id: row.request_id });
      await db.collection('outbox').updateOne(
        { request_id: row.request_id, status: 'publishing' },
        { $set: { status: 'published', published_at: new Date(), locked_at: null } }
      );
      log.info('outbox_published', { request_id: row.request_id });
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      if (attempts >= config.outboxMaxAttempts) {
        await db.collection('outbox').updateOne(
          { request_id: row.request_id },
          { $set: { status: 'failed', attempts, locked_at: null } }
        );
        await db.collection('jobs').updateOne(
          { request_id: row.request_id, status: 'pending' },
          {
            $set: {
              status: 'failed',
              error_code: sanitizeErrorCode('queue_unavailable'),
              updated_at: new Date(),
              completed_at: new Date(),
            },
          }
        );
        log.error('outbox_gave_up', { request_id: row.request_id, attempts });
      } else {
        const delay = computeBackoffMs(attempts, { baseMs: 500, capMs: 30000 });
        await db.collection('outbox').updateOne(
          { request_id: row.request_id },
          {
            $set: {
              status: 'pending',
              attempts,
              locked_at: null,
              next_attempt_at: new Date(Date.now() + delay),
            },
          }
        );
        log.error('outbox_publish_failed', { request_id: row.request_id, attempts, ...safeError(err) });
      }
    }
  }
  return batch.length;
}

function startOutboxPublisher({ db, channel, config, log }) {
  let stopped = false;
  let ticking = Promise.resolve();

  async function tick() {
    if (stopped) return;
    ticking = publishPending({ db, channel, config, log }).catch((err) => {
      log.error('outbox_tick_failed', safeError(err));
    });
    await ticking;
  }

  const timer = setInterval(() => {
    tick();
  }, config.outboxIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick();

  return async function stop() {
    stopped = true;
    clearInterval(timer);
    await ticking;
  };
}

module.exports = {
  publishPending,
  startOutboxPublisher,
  recoverStale,
};
