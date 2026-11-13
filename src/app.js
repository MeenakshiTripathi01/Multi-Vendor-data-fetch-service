'use strict';

const express = require('express');
const { createJobsRouter } = require('./api/jobs.routes');
const { createWebhookRouter } = require('./api/webhook.routes');
const { requestLogger, errorHandler } = require('./middleware/error-handler');

function createApp({ config, db, jobService, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    strict: false,
    limit: '1mb',
    verify(req, _res, buf) {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(requestLogger(log));

  app.get('/health', async (req, res) => {
    try {
      await db.command({ ping: 1 });
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(createJobsRouter({ db, jobService, log }));
  app.use(createWebhookRouter({ db, jobService, config, log }));
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(log));
  return app;
}

module.exports = {
  createApp,
};
