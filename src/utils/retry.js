'use strict';

// One queue per delay. RabbitMQ dead-letters the message back to `jobs`
// after the queue TTL, which gives us backoff without a delay plugin.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeBackoffMs(attempt, { baseMs = 1000, capMs = 16000 } = {}) {
  const exponent = Math.max(0, attempt - 1);
  const delay = baseMs * (2 ** exponent);
  return Math.min(capMs, delay);
}

function pickRetryQueue(jobsQueue, delayMs) {
  const chosen = RETRY_DELAYS_MS.find((delay) => delay >= delayMs) || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return {
    queue: `${jobsQueue}.retry.${chosen}`,
    delayMs: chosen,
  };
}

function parseRetryAfterMs(header) {
  if (header === undefined || header === null || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(String(header));
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

module.exports = {
  RETRY_DELAYS_MS,
  sleep,
  computeBackoffMs,
  pickRetryQueue,
  parseRetryAfterMs,
};
