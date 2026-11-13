'use strict';

// In-process sliding window used by each mock vendor.
// A call is allowed only when fewer than `limit` earlier calls have timestamps
// inside (now - windowMs, now]. The check and the record happen synchronously,
// so concurrent requests in this one process cannot exceed the limit.
//
// The worker does not use this limiter. Worker replicas share a MongoDB
// limiter so the cap still holds when more than one worker is running.

function createSlidingWindowLimiter({ limit, windowMs, now = Date.now }) {
  const hits = [];

  function tryTake() {
    const current = now();
    const threshold = current - windowMs;
    while (hits.length > 0 && hits[0] <= threshold) hits.shift();
    if (hits.length >= limit) {
      const retryAfterMs = Math.max(0, hits[0] + windowMs - current);
      return { allowed: false, retryAfterMs };
    }
    hits.push(current);
    return { allowed: true, retryAfterMs: 0 };
  }

  return { tryTake };
}

module.exports = {
  createSlidingWindowLimiter,
};
