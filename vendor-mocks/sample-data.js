'use strict';

// Deterministic vendor payload. Tests and the worker cleaner can rely on
// this shape. Whitespace and PII fields are intentional.

function buildVendorRecord(requestId) {
  return {
    vendor_reference: requestId,
    account_name: '  Ada Lovelace  ',
    email: 'ada@example.com',
    phone: ' 555-0100 ',
    ssn: '123-45-6789',
    balance: 42,
    active: true,
    note: null,
    tags: ['  gold ', 'priority'],
    profile: {
      city: '  London ',
      email: 'nested@example.com',
      score: 7,
    },
  };
}

module.exports = {
  buildVendorRecord,
};
