'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cleanResponse } = require('../../src/services/cleaner.service');

describe('response cleaning', () => {
  it('trims strings, redacts configured PII, and keeps unrelated values', () => {
    const cleaned = cleanResponse({
      account_name: '  Ada Lovelace  ',
      email: 'ada@example.com',
      phone: ' 555 ',
      ssn: '123-45-6789',
      Email: 'upper@example.com',
      balance: 42,
      active: true,
      note: null,
      tags: ['  gold ', 'priority'],
      profile: {
        city: '  London ',
        email: 'nested@example.com',
        score: 7,
      },
    });

    assert.equal(cleaned.account_name, 'Ada Lovelace');
    assert.equal(cleaned.email, '[REDACTED]');
    assert.equal(cleaned.phone, '[REDACTED]');
    assert.equal(cleaned.ssn, '[REDACTED]');
    assert.equal(cleaned.Email, '[REDACTED]');
    assert.equal(cleaned.balance, 42);
    assert.equal(cleaned.active, true);
    assert.equal(cleaned.note, null);
    assert.deepEqual(cleaned.tags, ['gold', 'priority']);
    assert.equal(cleaned.profile.city, 'London');
    assert.equal(cleaned.profile.email, '[REDACTED]');
    assert.equal(cleaned.profile.score, 7);
  });

  it('does not mutate the original value', () => {
    const original = {
      email: ' ada@example.com ',
      name: '  Ada ',
      tags: ['  a '],
      profile: { city: '  London ' },
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    cleanResponse(original);
    assert.deepEqual(original, snapshot);
  });

  it('handles missing fields, empty objects, and custom PII names', () => {
    const cleaned = cleanResponse(
      { name: '  Ana ', tax_id: '999', extra: { tax_id: '  12 ' } },
      ['tax_id']
    );
    assert.equal(cleaned.name, 'Ana');
    assert.equal(cleaned.tax_id, '[REDACTED]');
    assert.equal(cleaned.extra.tax_id, '[REDACTED]');
    assert.deepEqual(cleanResponse({}), {});
    assert.equal(cleanResponse('  hi  '), 'hi');
    assert.equal(cleanResponse(null), null);
    assert.equal(cleanResponse(12), 12);
  });
});
