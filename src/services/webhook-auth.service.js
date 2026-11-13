'use strict';

const crypto = require('crypto');

// Callbacks use HMAC-SHA256 over the exact raw request bytes.
// Header: X-Vendor-Signature: sha256=<hex digest>
// The comparison is constant-time when both strings are the same length.

function signBody(rawBody, secret) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const digest = crypto.createHmac('sha256', secret).update(bytes).digest('hex');
  return `sha256=${digest}`;
}

function verifySignature(rawBody, header, secret) {
  if (!rawBody || typeof header !== 'string' || !secret) return false;
  const expected = signBody(rawBody, secret);
  const actual = Buffer.from(header);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return crypto.timingSafeEqual(actual, wanted);
}

module.exports = {
  signBody,
  verifySignature,
};
