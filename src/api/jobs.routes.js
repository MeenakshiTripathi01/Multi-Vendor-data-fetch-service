'use strict';

const crypto = require('crypto');
const express = require('express');
const { isUuid, selectVendor, toPublicView } = require('../utils/ids');
const { sanitizeErrorCode } = require('../utils/errors');
const { safeError } = require('../utils/logger');

function createJobsRouter({ db, jobService, log }) {
  const router = express.Router();

  router.post('/jobs', async (req, res) => {
    if (req.body === undefined) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const vendor = selectVendor(req.body, req.query);
    if (!vendor) {
      res.status(400).json({ error: 'invalid_vendor' });
      return;
    }

    const requestId = crypto.randomUUID();
    try {
      await jobService.createJob(db, {
        requestId,
        payload: req.body,
        vendor,
      });
    } catch (err) {
      log.error('job_create_failed', { request_id: requestId, ...safeError(err) });
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    // 202 means the job is durable in MongoDB. The outbox publisher moves it
    // to RabbitMQ shortly after. This handler does not call a vendor.
    res.status(202).json({ request_id: requestId });
  });

  router.get('/jobs/:request_id', async (req, res) => {
    const requestId = req.params.request_id;
    if (!isUuid(requestId)) {
      res.status(400).json({ error: 'invalid_request_id' });
      return;
    }

    try {
      const job = await jobService.getByRequestId(db, requestId);
      if (!job) {
        res.status(404).json({ error: 'job_not_found' });
        return;
      }
      const view = toPublicView(job, sanitizeErrorCode);
      res.status(view.http).json(view.body);
    } catch (err) {
      log.error('job_read_failed', { request_id: requestId, ...safeError(err) });
      res.status(503).json({ error: 'unavailable' });
    }
  });

  return router;
}

module.exports = {
  createJobsRouter,
};
