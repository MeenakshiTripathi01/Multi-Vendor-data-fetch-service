'use strict';

function requestLogger(log) {
  return function logRequest(req, res, next) {
    res.on('finish', () => {
      log.info('http_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
    next();
  };
}

function errorHandler(log) {
  return function handleError(err, req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    const parseFailed = err && (
      err.type === 'entity.parse.failed'
      || (err instanceof SyntaxError && err.status === 400)
    );
    if (parseFailed) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    log.error('unhandled_error', { error_name: err && err.name ? err.name : 'Error' });
    res.status(500).json({ error: 'internal_error' });
  };
}

module.exports = {
  requestLogger,
  errorHandler,
};
