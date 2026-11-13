'use strict';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      let closed = false;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close() {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((done) => {
            // Drop idle keep-alive sockets so the test process can exit.
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
    server.on('error', reject);
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text, headers: response.headers };
}

function createFakeChannel() {
  const events = [];
  return {
    events,
    sendToQueue(queue, content, _options, callback) {
      events.push({
        type: 'publish',
        queue,
        body: JSON.parse(content.toString('utf8')),
      });
      if (typeof callback === 'function') callback();
      return true;
    },
    ack() {
      events.push({ type: 'ack' });
    },
    nack(_message, _allUpTo, requeue) {
      events.push({ type: 'nack', requeue: Boolean(requeue) });
    },
  };
}

function jobMessage(requestId) {
  return { content: Buffer.from(JSON.stringify({ request_id: requestId })) };
}

module.exports = {
  listen,
  request,
  createFakeChannel,
  jobMessage,
};
