'use strict';

const express = require('express');
const { isUuid } = require('../utils/ids');
const { verifySignature } = require('../services/webhook-auth.service');
const { safeError } = require('../utils/logger');

function sendOutcome(res, outcome) {
  if (outcome.type === 'completed') return res.status(200).json({ status: 'complete' });
  if (outcome.type === 'failed') return res.status(200).json({ status: 'failed' });
  if (outcome.type === 'duplicate') return res.status(200).json({ status: 'duplicate' });
  if (outcome.type === 'not_found') return res.status(404).json({ error: 'job_not_found' });
  if (outcome.type === 'conflict') return res.status(409).json({ error: 'conflict' });
  return res.status(400).json({ error: 'invalid_payload' });
}

function createWebhookRouter({ db, jobService, config, log }) {
  const router = express.Router();

  router.post('/vendor-webhook/:vendor', async (req, res) => {
    if (req.params.vendor !== 'async') {
      res.status(404).json({ error: 'unknown_vendor' });
      return;
    }

    const header = req.get('x-vendor-signature');
    if (!verifySignature(req.rawBody, header, config.webhookSecret)) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!isUuid(body.request_id)) {
      res.status(400).json({ error: 'invalid_request_id' });
      return;
    }
    if (body.status !== 'success' && body.status !== 'failed') {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (body.status === 'success' && body.result === undefined) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (body.vendor_job_id !== undefined && typeof body.vendor_job_id !== 'string') {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    try {
      const outcome = await jobService.applyWebhook(db, {
        requestId: body.request_id,
        vendorJobId: body.vendor_job_id || null,
        status: body.status,
        result: body.result,
        errorCode: body.error_code,
      });
      log.info('webhook_applied', { request_id: body.request_id, outcome: outcome.type });
      sendOutcome(res, outcome);
    } catch (err) {
      // 500 asks the vendor to retry. The job is unchanged if the write threw.
      log.error('webhook_persist_failed', { request_id: body.request_id, ...safeError(err) });
      res.status(500).json({ error: 'unavailable' });
    }
  });

  return router;
}

module.exports = {
  createWebhookRouter,
};
