'use strict';

// Public error codes are a fixed set. Anything else is replaced so vendor
// text, stack traces, and connection strings never reach the client.
const ERROR_CODES = new Set([
  'vendor_timeout',
  'vendor_unavailable',
  'invalid_vendor_response',
  'rate_limited',
  'max_retries_exceeded',
  'vendor_rejected',
  'queue_unavailable',
]);

class VendorError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'VendorError';
    this.code = code;
    this.permanent = Boolean(options.permanent);
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
  }
}

function sanitizeErrorCode(code) {
  if (ERROR_CODES.has(code)) return code;
  return 'vendor_unavailable';
}

function classifyVendorFailure(err) {
  if (err && err.name === 'VendorError') {
    return {
      permanent: Boolean(err.permanent),
      errorCode: sanitizeErrorCode(err.code),
      retryAfterMs: err.retryAfterMs || null,
    };
  }
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { permanent: false, errorCode: 'vendor_timeout', retryAfterMs: null };
  }
  return { permanent: false, errorCode: 'vendor_unavailable', retryAfterMs: null };
}

module.exports = {
  ERROR_CODES,
  VendorError,
  sanitizeErrorCode,
  classifyVendorFailure,
};
