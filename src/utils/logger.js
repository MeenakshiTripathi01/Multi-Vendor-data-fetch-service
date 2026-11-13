'use strict';

const LEVELS = { error: 0, info: 1, debug: 2 };

// Only primitive fields are written. Objects such as payloads and vendor
// bodies are dropped so a new log call cannot accidentally record PII.
const SENSITIVE_KEYS = new Set([
  'payload',
  'result',
  'email',
  'phone',
  'ssn',
  'authorization',
  'password',
  'body',
  'data',
  'raw',
  'customer',
  'secret',
  'webhook_secret',
  'token',
]);

function scrub(text) {
  return String(text)
    .replace(/amqp:\/\/\S+/gi, 'amqp://redacted')
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, 'mongodb://redacted')
    .slice(0, 300);
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    if (typeof value === 'string') safe[key] = scrub(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
  }
  return safe;
}

function createLogger(levelName = 'info') {
  const current = LEVELS[levelName] === undefined ? LEVELS.info : LEVELS[levelName];

  function write(level, message, fields) {
    if (LEVELS[level] > current) return;
    const line = {
      time: new Date().toISOString(),
      level,
      message,
      ...sanitizeFields(fields),
    };
    console.log(JSON.stringify(line));
  }

  return {
    error(message, fields) { write('error', message, fields); },
    info(message, fields) { write('info', message, fields); },
    debug(message, fields) { write('debug', message, fields); },
  };
}

function safeError(err) {
  return {
    error_name: err && err.name ? String(err.name) : 'Error',
    error_message: scrub(err && err.message ? err.message : 'unknown error'),
  };
}

module.exports = {
  createLogger,
  safeError,
  scrub,
};
