'use strict';

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    let parseError = false;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseError = true;
      }
    }
    return {
      status: response.status,
      body: parsed,
      parseError,
      retryAfter: response.headers.get('retry-after'),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeout = new Error('vendor_timeout');
      timeout.name = 'AbortError';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  postJson,
};
