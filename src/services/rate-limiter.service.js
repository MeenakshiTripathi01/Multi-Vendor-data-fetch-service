'use strict';

const { VendorError } = require('../utils/errors');
const { sleep } = require('../utils/retry');

// Shared limiter for every worker process.
//
// Semantics: at most `limit` grants in any rolling `windowMs` window, per
// vendor. Each grant stores Date.now() on one MongoDB document for that
// vendor. The update is conditional on `version`, so two workers cannot both
// commit a grant from the same prior snapshot. That is what keeps the
// combined traffic of every replica inside the vendor's cap. A per-process
// sleep would not.
//
// The stored timestamps are application clocks. Large clock skew between
// machines can let the window drift by about that skew. Denial never calls
// the vendor. If MongoDB cannot confirm the reservation, the call is not made.

function createRateLimiter(db, options) {
  const limit = options.limit;
  const windowMs = options.windowMs;
  const maxWaitMs = options.maxWaitMs;
  const collection = () => db.collection('vendor_rate_limits');

  async function tryAcquire(vendor) {
    if (limit < 1) return false;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const now = Date.now();
      const existing = await collection().findOne({ _id: vendor });
      const version = existing ? existing.version : 0;
      const hits = (existing && Array.isArray(existing.hits) ? existing.hits : [])
        .filter((timestamp) => now - timestamp < windowMs);

      const granted = hits.length < limit;
      const nextHits = granted ? hits.concat(now) : hits;

      try {
        if (!existing) {
          if (!granted) return false;
          await collection().insertOne({
            _id: vendor,
            hits: nextHits,
            version: 1,
            updated_at: new Date(now),
          });
          return true;
        }

        const result = await collection().updateOne(
          { _id: vendor, version },
          { $set: { hits: nextHits, version: version + 1, updated_at: new Date(now) } }
        );
        if (result.modifiedCount === 1) return granted;
      } catch (err) {
        if (!err || err.code !== 11000) throw err;
      }
    }

    const error = new VendorError('rate_limited', { retryAfterMs: windowMs });
    throw error;
  }

  async function acquire(vendor) {
    const deadline = Date.now() + maxWaitMs;
    while (true) {
      const granted = await tryAcquire(vendor);
      if (granted) return;
      if (Date.now() >= deadline) {
        throw new VendorError('rate_limited', { retryAfterMs: windowMs });
      }
      // The document above is the limiter. This pause only avoids a tight poll
      // while the current window is full.
      await sleep(Math.max(25, Math.ceil(windowMs / Math.max(limit, 1))));
    }
  }

  return { tryAcquire, acquire };
}

module.exports = {
  createRateLimiter,
};
