const { invalid } = require('../domain/errors');

// Input helpers for use cases. Framework-free: they work on plain command objects.

const ID = /^[a-f0-9]{24}$/i;
const isId = (value) => typeof value === 'string' ? ID.test(value) : ID.test(String(value || ''));

const requireId = (value, field) => {
  if (!value || !isId(value)) throw invalid(`Valid ${field} is required`);
  return String(value);
};

// Copies only the listed keys that are present (whitelists input).
const pick = (source = {}, keys) =>
  keys.reduce((out, key) => {
    if (source[key] !== undefined) out[key] = source[key];
    return out;
  }, {});

// Optional non-negative number; empty means 0.
const toNumber = (value, field, { min = 0 } = {}) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw invalid(`${field} must be a number ≥ ${min}`);
  return n;
};

const requireText = (value, field, { min = 1 } = {}) => {
  const s = String(value ?? '').trim();
  if (s.length < min) throw invalid(`${field} is required`);
  return s;
};

module.exports = { isId, requireId, pick, toNumber, requireText };
