'use strict';

const { connectMongo } = require('./db/mongo');
const { connectRabbit, assertTopology } = require('./services/queue.service');
const { createJobService } = require('./services/job.service');

async function connectInfrastructure(config, log) {
  const mongo = await connectMongo(config, log);
  const jobs = createJobService({ piiFields: config.piiFields });
  await jobs.ensureIndexes(mongo.db);
  const rabbit = await connectRabbit(config, log);
  await assertTopology(rabbit.channel, config);
  return {
    client: mongo.client,
    db: mongo.db,
    connection: rabbit.connection,
    channel: rabbit.channel,
    jobs,
  };
}

module.exports = {
  connectInfrastructure,
};
