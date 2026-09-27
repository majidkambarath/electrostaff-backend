const mongoose = require('mongoose');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Forwards rejected promises from async route handlers to the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Copies only the listed keys that are present on the source (whitelists request bodies).
const pick = (source = {}, keys) =>
  keys.reduce((out, key) => {
    if (source[key] !== undefined) out[key] = source[key];
    return out;
  }, {});

const requireId = (value, field) => {
  if (!value || !mongoose.isValidObjectId(value)) throw new HttpError(400, `Valid ${field} is required`);
  return value;
};

const toNumber = (value, field, { min = 0 } = {}) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${field} must be a number ≥ ${min}`);
  return n;
};

module.exports = { HttpError, asyncHandler, pick, requireId, toNumber };
