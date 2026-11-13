'use strict';

const { loadConfig } = require('./config');
const { createLogger, safeError } = require('./utils/logger');
const { connectInfrastructure } = require('./bootstrap');
const { createApp } = require('./app');
const { startOutboxPublisher } = require('./services/outbox.publisher');

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const infra = await connectInfrastructure(config, log);
  const app = createApp({
    config,
    db: infra.db,
    jobService: infra.jobs,
    log,
  });
  const stopPublisher = startOutboxPublisher({
    db: infra.db,
    channel: infra.channel,
    config,
    log,
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(config.port, () => resolve(listening));
  });
  log.info('api_listening', { port: config.port });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('api_shutdown', { signal });
    try { await stopPublisher(); } catch (err) { log.error('publisher_stop_failed', safeError(err)); }
    await new Promise((resolve) => server.close(() => resolve()));
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
    const fields = safeError(err);
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'api_start_failed',
      ...fields,
    }));
    process.exit(1);
  });
}

module.exports = { main };
