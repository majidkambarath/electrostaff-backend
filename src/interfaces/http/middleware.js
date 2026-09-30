const { DomainError, unauthorized, forbidden } = require('../../domain/errors');

const STATUS_BY_CODE = {
  INVALID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

// Wraps a use-case call: the handler returns data, which is sent as JSON.
const handle = (fn, status = 200) => async (req, res, next) => {
  try {
    res.status(status).json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

// Sends a stored file ({ contentType, data }) returned by a use case.
const sendFile = (fn) => async (req, res, next) => {
  try {
    const { contentType, data } = await fn(req);
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.send(data);
  } catch (err) {
    next(err);
  }
};

// Resolves the bearer token to req.principal and scopes the request to its organization.
const authenticate = (authService) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    req.principal = await authService.authenticate(token);
    req.orgId = req.principal.organizationId;
    next();
  } catch (err) {
    next(err);
  }
};

// An expired plan leaves the office read-only: it can look, not change (password and
// notification settings still work). The staff app keeps working so attendance isn't lost.
const READ_ONLY_ALLOWED = new Set(['/auth/change-password', '/notifications/read', '/notifications/subscribe', '/notifications/unsubscribe']);
const readOnlyGuard = (req, res, next) =>
  req.principal?.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !READ_ONLY_ALLOWED.has(req.path)
    ? next(forbidden('Your plan has ended, so the app is read-only. Contact ElectroStaff to renew.'))
    : next();

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.principal?.role) ? next() : next(forbidden());

const notFound = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let status = 500;
  let message = err.message || 'Something went wrong';

  if (err instanceof DomainError) status = STATUS_BY_CODE[err.code] || 400;
  else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.code === 11000) {
    status = 409;
    message = 'A record with the same details already exists';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  }

  if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 ? 'Something went wrong on the server' : message });
};

module.exports = { handle, sendFile, authenticate, readOnlyGuard, requireRole, notFound, errorHandler };
