const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const buildRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware');

// Removes keys starting with "$" or containing "." from request input so values like
// { "$gt": "" } can never reach a database query as operators (NoSQL injection).
const stripOperators = (value) => {
  if (Array.isArray(value)) return value.map(stripOperators);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('$') && !key.includes('.'))
        .map(([key, v]) => [key, stripOperators(v)])
    );
  }
  return value;
};

const sanitizeInput = (req, res, next) => {
  if (req.body) req.body = stripOperators(req.body);
  // Express 4 exposes req.query as a plain object we can clean in place.
  for (const key of Object.keys(req.query)) {
    if (key.startsWith('$') || typeof req.query[key] === 'object') delete req.query[key];
  }
  next();
};

// Express app for a composed container of services.
const createApp = (services, config = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  // Security headers for API responses. Scoped to /api so a web app served from the same
  // server keeps its own policy (its screenshots/proofs use blob: images).
  app.use('/api', helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  const origins = config.corsOrigins?.length ? config.corsOrigins : true;
  app.use(cors({ origin: origins, maxAge: 600 }));

  // Upload routes accept small base64 images; everything else stays tiny.
  app.use('/api/payments', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use(sanitizeInput);

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: config.rateLimitPerMinute || 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { message: 'Too many requests. Please slow down and try again in a minute.' },
    })
  );
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: config.authRateLimit || 50,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { message: 'Too many sign-in attempts. Please wait 15 minutes.' },
    })
  );

  app.use('/api', buildRoutes(services));
  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
};

module.exports = { createApp, stripOperators };
