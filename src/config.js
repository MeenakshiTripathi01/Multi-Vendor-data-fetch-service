'use strict';

// All runtime settings come from the environment so the same image can run
// as the API, the worker, or either mock vendor.

function numberFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const webhookSecret = env.WEBHOOK_SECRET || 'dev-webhook-secret-change-me';
  if (webhookSecret.length < 8) {
    throw new Error('WEBHOOK_SECRET must be at least 8 characters');
  }

  const piiRaw = env.PII_FIELDS;
  const piiFields = (piiRaw === undefined ? 'email,phone,ssn' : piiRaw)
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);

  return {
    port: numberFrom(env, 'PORT', 3000),
    mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017/vendor_fetch?replicaSet=rs0',
    mongoDb: env.MONGO_DB || 'vendor_fetch',
    mongoConnectRetries: numberFrom(env, 'MONGO_CONNECT_RETRIES', 30),
    rabbitUrl: env.RABBITMQ_URL || 'amqp://vendor:vendor@127.0.0.1:5672',
    rabbitConnectRetries: numberFrom(env, 'RABBIT_CONNECT_RETRIES', 30),
    jobsQueue: env.JOBS_QUEUE || 'jobs',
    webhookSecret,
    syncVendorUrl: env.SYNC_VENDOR_URL || 'http://127.0.0.1:4001',
    asyncVendorUrl: env.ASYNC_VENDOR_URL || 'http://127.0.0.1:4002',
    asyncWebhookUrl: env.ASYNC_WEBHOOK_URL || 'http://127.0.0.1:3000/vendor-webhook/async',
    syncVendorPort: numberFrom(env, 'SYNC_VENDOR_PORT', 4001),
    asyncVendorPort: numberFrom(env, 'ASYNC_VENDOR_PORT', 4002),
    vendorRateLimit: numberFrom(env, 'VENDOR_RATE_LIMIT', 2),
    vendorRateWindowMs: numberFrom(env, 'VENDOR_RATE_WINDOW_MS', 1000),
    rateLimitMaxWaitMs: numberFrom(env, 'RATE_LIMIT_MAX_WAIT_MS', 20000),
    workerMaxAttempts: numberFrom(env, 'WORKER_MAX_ATTEMPTS', 5),
    workerPrefetch: numberFrom(env, 'WORKER_PREFETCH', 1),
    workerLeaseMs: numberFrom(env, 'WORKER_LEASE_MS', 15000),
    syncVendorLatencyMs: numberFrom(env, 'SYNC_VENDOR_LATENCY_MS', 0),
    syncVendorTimeoutMs: numberFrom(env, 'SYNC_VENDOR_TIMEOUT_MS', 2000),
    syncVendorTimeoutDelayMs: numberFrom(env, 'SYNC_VENDOR_TIMEOUT_DELAY_MS', 10000),
    asyncVendorDelayMs: numberFrom(env, 'ASYNC_VENDOR_DELAY_MS', 400),
    asyncVendorTimeoutMs: numberFrom(env, 'ASYNC_VENDOR_TIMEOUT_MS', 2000),
    webhookMaxRetries: numberFrom(env, 'WEBHOOK_MAX_RETRIES', 5),
    webhookRetryBaseMs: numberFrom(env, 'WEBHOOK_RETRY_BASE_MS', 200),
    webhookTimeoutMs: numberFrom(env, 'WEBHOOK_TIMEOUT_MS', 2000),
    outboxIntervalMs: numberFrom(env, 'OUTBOX_INTERVAL_MS', 500),
    outboxMaxAttempts: numberFrom(env, 'OUTBOX_MAX_ATTEMPTS', 10),
    outboxLockMs: numberFrom(env, 'OUTBOX_LOCK_MS', 30000),
    retryBaseMs: numberFrom(env, 'RETRY_BASE_MS', 1000),
    retryCapMs: numberFrom(env, 'RETRY_CAP_MS', 16000),
    logLevel: env.LOG_LEVEL || 'info',
    piiFields: piiFields.length > 0 ? piiFields : ['email', 'phone', 'ssn'],
  };
}

module.exports = {
  loadConfig,
};
