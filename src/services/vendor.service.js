'use strict';

const { VendorError } = require('../utils/errors');
const { parseRetryAfterMs } = require('../utils/retry');
const { postJson } = require('../utils/http');

function scenarioOf(job) {
  if (job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)) {
    if (typeof job.payload.scenario === 'string' && job.payload.scenario.length > 0) {
      return job.payload.scenario;
    }
  }
  return 'success';
}

function throwForStatus(response) {
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.retryAfter);
    throw new VendorError('rate_limited', { retryAfterMs: retryAfterMs === null ? 1000 : retryAfterMs });
  }
  if (response.status >= 500) throw new VendorError('vendor_unavailable');
  if (response.status >= 400) throw new VendorError('vendor_rejected', { permanent: true });
}

async function callSyncVendor(config, job) {
  const response = await postJson(
    `${config.syncVendorUrl}/vendor/fetch`,
    {
      request_id: job.request_id,
      scenario: scenarioOf(job),
      payload: job.payload,
    },
    config.syncVendorTimeoutMs
  );
  throwForStatus(response);
  if (response.parseError || response.body === null || typeof response.body !== 'object') {
    throw new VendorError('invalid_vendor_response', { permanent: true });
  }
  return response.body;
}

async function callAsyncVendor(config, job) {
  const response = await postJson(
    `${config.asyncVendorUrl}/vendor/jobs`,
    {
      request_id: job.request_id,
      scenario: scenarioOf(job),
      webhook_url: config.asyncWebhookUrl,
      payload: job.payload,
    },
    config.asyncVendorTimeoutMs
  );
  throwForStatus(response);
  if (
    response.parseError
    || !response.body
    || typeof response.body !== 'object'
    || typeof response.body.vendor_job_id !== 'string'
  ) {
    throw new VendorError('invalid_vendor_response', { permanent: true });
  }
  return { vendor_job_id: response.body.vendor_job_id };
}

module.exports = {
  scenarioOf,
  callSyncVendor,
  callAsyncVendor,
};
