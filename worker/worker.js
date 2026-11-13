'use strict';

const { loadConfig } = require('../src/config');
const { createLogger, safeError } = require('../src/utils/logger');
const { sleep } = require('../src/utils/retry');
const { connectInfrastructure } = require('../src/bootstrap');
const { createRateLimiter } = require('../src/services/rate-limiter.service');
const { processDelivery } = require('./processor');

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const infra = await connectInfrastructure(config, log);
  const rateLimiter = createRateLimiter(infra.db, {
    limit: config.vendorRateLimit,
    windowMs: config.vendorRateWindowMs,
    maxWaitMs: config.rateLimitMaxWaitMs,
  });

  await infra.channel.prefetch(config.workerPrefetch);
  const inFlight = new Set();
  let stopping = false;

  const consumer = await infra.channel.consume(config.jobsQueue, (msg) => {
    if (!msg || stopping) return;
    const task = handle(msg).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }, { noAck: false });

  log.info('worker_consuming', { queue: config.jobsQueue, prefetch: config.workerPrefetch });

  async function handle(msg) {
    try {
      await processDelivery({
        channel: infra.channel,
        msg,
        db: infra.db,
        jobs: infra.jobs,
        config,
        rateLimiter,
        log,
      });
    } catch (err) {
      // The outcome was not recorded. Requeue after a short pause so a
      // database blip does not spin, and do not ack a message we could not save.
      log.error('job_handler_error', safeError(err));
      await sleep(1000);
      try { infra.channel.nack(msg, false, true); } catch { /* channel closed */ }
    }
  }

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('worker_shutdown', { signal });
    try { await infra.channel.cancel(consumer.consumerTag); } catch { /* already canceled */ }
    const deadline = Date.now() + 10000;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    try { await infra.channel.close(); } catch { /* already closed */ }
    try { await infra.connection.close(); } catch { /* already closed */ }
    try { await infra.client.close(); } catch { /* already closed */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  infra.connection.on('error', (err) => log.error('rabbit_connection_error', safeError(err)));
  infra.connection.on('close', () => {
    if (!stopping) {
      log.error('rabbit_connection_closed', {});
      process.exit(1);
    }
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'worker_start_failed',
      ...safeError(err),
    }));
    process.exit(1);
  });
}

module.exports = { main };
