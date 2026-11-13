'use strict';

// Cleaning policy:
// - Copy the value. The vendor payload passed in is never mutated.
// - Trim leading and trailing whitespace on every string, including strings
//   nested in objects and arrays.
// - Replace any field whose name matches the configured PII list
//   (default: email, phone, ssn, case-insensitive) with "[REDACTED]".
//   The original value of that field is discarded, even when it is nested.
// - Numbers, booleans, and null are preserved.
//
// Limitations: this does not detect PII hidden inside free text, custom field
// names, arrays of unlabeled strings, or encoded values. Request payloads
// stored on the job are not run through this cleaner; only vendor results are.

const REDACTED = '[REDACTED]';

function cleanResponse(value, piiFields = ['email', 'phone', 'ssn']) {
  const blocked = new Set(piiFields.map((field) => String(field).toLowerCase()));
  return cleanValue(value, blocked);
}

function cleanValue(value, blocked) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, blocked));
  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const key of Object.keys(value)) {
      if (blocked.has(key.toLowerCase())) {
        cleaned[key] = REDACTED;
      } else {
        cleaned[key] = cleanValue(value[key], blocked);
      }
    }
    return cleaned;
  }
  return value;
}

module.exports = {
  cleanResponse,
  REDACTED,
};
