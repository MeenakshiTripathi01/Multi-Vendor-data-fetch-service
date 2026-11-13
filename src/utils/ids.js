'use strict';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDORS = new Set(['sync', 'async']);

function isUuid(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

// Query `?vendor=` wins when it is present. A JSON object may also carry
// `vendor`. Anything else defaults to the synchronous vendor. Unknown names
// are rejected by the caller.
function selectVendor(body, query) {
  let vendor;
  if (query && typeof query.vendor === 'string' && query.vendor.length > 0) {
    vendor = query.vendor;
  } else if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.vendor === 'string') {
    vendor = body.vendor;
  } else {
    vendor = 'sync';
  }
  if (!VENDORS.has(vendor)) return null;
  return vendor;
}

function toPublicView(job, sanitizeErrorCode) {
  if (job.status === 'complete') {
    return {
      http: 200,
      body: {
        status: 'complete',
        result: job.result === undefined ? null : job.result,
      },
    };
  }
  if (job.status === 'failed') {
    return {
      http: 200,
      body: {
        status: 'failed',
        error_code: sanitizeErrorCode(job.error_code),
      },
    };
  }
  return { http: 200, body: { status: 'processing' } };
}

module.exports = {
  isUuid,
  selectVendor,
  toPublicView,
  VENDORS,
};
