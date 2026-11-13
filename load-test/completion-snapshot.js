'use strict';

// Reads stored job statuses and the RabbitMQ jobs queue.
// This does not call POST /jobs and does not treat HTTP 202 as completion.
//
// Prerequisites: Compose stack up, npm install already run, and this file
// started from the project directory. MongoDB must be reachable on
// 127.0.0.1:$MONGO_HOST_PORT (default 27017; this workspace uses 27018).
// The URL uses directConnection=true because the replica set advertises
// the Docker hostname "mongo". RabbitMQ management must answer on
// 127.0.0.1:15672 (RABBITMQ_MGMT_PORT) as user vendor.
//
//   $env:MONGO_HOST_PORT = "27018"
//   node load-test/completion-snapshot.js

const { MongoClient } = require('mongodb');

function scrub(text) {
  return String(text)
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, 'mongodb://redacted')
    .replace(/amqp:\/\/\S+/gi, 'amqp://redacted');
}

async function main() {
  const mongoPort = process.env.MONGO_HOST_PORT || '27017';
  const mongoUrl = process.env.SNAPSHOT_MONGO_URL
    || `mongodb://127.0.0.1:${mongoPort}/vendor_fetch?directConnection=true`;
  const rabbitPort = process.env.RABBITMQ_MGMT_PORT || '15672';
  const rabbitUser = process.env.RABBITMQ_USER || 'vendor';
  const rabbitPass = process.env.RABBITMQ_PASS || 'vendor';
  const queueName = process.env.JOBS_QUEUE || 'jobs';

  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  let rows;
  let latencyRows;
  try {
    const jobs = client.db('vendor_fetch').collection('jobs');
    rows = await jobs.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]).toArray();
    latencyRows = await jobs.aggregate([
      {
        $match: {
          status: { $in: ['complete', 'failed'] },
          created_at: { $type: 'date' },
          completed_at: { $type: 'date' },
        },
      },
      {
        $project: {
          status: 1,
          ms: { $subtract: ['$completed_at', '$created_at'] },
        },
      },
      {
        $group: {
          _id: '$status',
          n: { $sum: 1 },
          min_ms: { $min: '$ms' },
          max_ms: { $max: '$ms' },
          avg_ms: { $avg: '$ms' },
        },
      },
    ]).toArray();
  } finally {
    await client.close();
  }

  const jobsByStatus = { pending: 0, processing: 0, complete: 0, failed: 0 };
  let jobsTotal = 0;
  for (const row of rows) {
    jobsTotal += row.n;
    if (Object.prototype.hasOwnProperty.call(jobsByStatus, row._id)) {
      jobsByStatus[row._id] = row.n;
    }
  }

  const auth = Buffer.from(`${rabbitUser}:${rabbitPass}`).toString('base64');
  const queueUrl = `http://127.0.0.1:${rabbitPort}/api/queues/%2F/${encodeURIComponent(queueName)}`;
  const response = await fetch(queueUrl, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    throw new Error(`RabbitMQ management returned HTTP ${response.status} for queue ${queueName}`);
  }
  const queue = await response.json();

  const storedLatencyMs = {};
  for (const row of latencyRows) {
    storedLatencyMs[row._id] = {
      jobs: row.n,
      min_ms: row.min_ms,
      avg_ms: row.avg_ms,
      max_ms: row.max_ms,
    };
  }

  console.log(JSON.stringify({
    note: 'Stored job statuses, time from created_at to completed_at, and RabbitMQ depth. A 202 from POST /jobs is not a completed job.',
    jobs_by_status: jobsByStatus,
    jobs_total: jobsTotal,
    stored_processing_latency_ms: storedLatencyMs,
    queue: {
      name: queueName,
      messages: queue.messages,
      messages_ready: queue.messages_ready,
      messages_unacknowledged: queue.messages_unacknowledged,
      consumers: queue.consumers,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error && error.name ? error.name : 'Error',
    message: scrub(error && error.message ? error.message : 'snapshot failed'),
  }));
  process.exit(1);
});
