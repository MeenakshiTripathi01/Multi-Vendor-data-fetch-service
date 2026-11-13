'use strict';

const { MongoClient } = require('mongodb');
const { sleep } = require('../utils/retry');

function unwrapFindAndModify(result) {
  if (!result) return null;
  // Driver 5 returned { value }. Driver 6 returns the document itself.
  if (Object.prototype.hasOwnProperty.call(result, 'lastErrorObject')) return result.value || null;
  return result;
}

async function waitForPrimary(client, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary || hello.ismaster) return;
    } catch {
      // The replica set is still electing a primary.
    }
    await sleep(250);
  }
  throw new Error('mongo primary not available');
}

async function connectMongo(config, log) {
  let lastError;
  for (let attempt = 1; attempt <= config.mongoConnectRetries; attempt += 1) {
    const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      await waitForPrimary(client, 8000);
      if (log) log.info('mongo_connected', { attempt });
      return { client, db: client.db(config.mongoDb) };
    } catch (err) {
      lastError = err;
      try { await client.close(); } catch { /* ignore a failed close */ }
      if (log) log.info('mongo_not_ready', { attempt });
      await sleep(1000);
    }
  }
  throw lastError;
}

module.exports = {
  connectMongo,
  unwrapFindAndModify,
  waitForPrimary,
};
