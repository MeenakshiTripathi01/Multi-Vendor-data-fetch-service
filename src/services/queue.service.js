'use strict';

const amqplib = require('amqplib');
const { RETRY_DELAYS_MS, sleep } = require('../utils/retry');

async function connectRabbit(config, log) {
  let lastError;
  for (let attempt = 1; attempt <= config.rabbitConnectRetries; attempt += 1) {
    try {
      const connection = await amqplib.connect(config.rabbitUrl);
      const channel = await connection.createConfirmChannel();
      if (log) log.info('rabbit_connected', { attempt });
      return { connection, channel };
    } catch (err) {
      lastError = err;
      if (log) log.info('rabbit_not_ready', { attempt });
      await sleep(1000);
    }
  }
  throw lastError;
}

async function assertTopology(channel, config) {
  const queue = config.jobsQueue;
  const deadLetterExchange = `${queue}.dlx`;
  const deadLetterQueue = `${queue}.dlq`;

  await channel.assertExchange(deadLetterExchange, 'direct', { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true });
  await channel.bindQueue(deadLetterQueue, deadLetterExchange, deadLetterQueue);

  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': deadLetterExchange,
      'x-dead-letter-routing-key': deadLetterQueue,
    },
  });

  for (const delay of RETRY_DELAYS_MS) {
    const retryQueue = `${queue}.retry.${delay}`;
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': delay,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      },
    });
  }
}

// Resolves only after the broker confirms the persistent message, or
// immediately for the in-memory test double (it has no waitForConfirms).
function publishConfirmed(channel, queue, body) {
  const content = Buffer.from(JSON.stringify(body));
  const options = {
    persistent: true,
    deliveryMode: 2,
    contentType: 'application/json',
    messageId: body.request_id,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    let wrote = false;
    try {
      wrote = channel.sendToQueue(queue, content, options, finish);
    } catch (err) {
      finish(err);
      return;
    }

    if (wrote === true && typeof channel.waitForConfirms !== 'function') finish();
  });
}

module.exports = {
  connectRabbit,
  assertTopology,
  publishConfirmed,
};
