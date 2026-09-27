const { HttpError } = require('./http');

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 1000 * 60 * 60 * 24;

// 'YYYY-MM-DD' strings are parsed as local calendar days (new Date('YYYY-MM-DD') would be UTC
// midnight, which shifts the day for servers west of UTC).
const toDate = (value) => {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'string') {
    const m = value.match(ISO_DAY);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(value);
};

const startOfDay = (date) => {
  const d = toDate(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = toDate(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const addDays = (date, days) => {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
};

const daysBetween = (start, end) => {
  const s = startOfDay(start);
  const e = startOfDay(end);
  return Math.round((e - s) / DAY_MS) + 1;
};

// Local 'YYYY-MM-DD' key, used for grouping records by calendar day.
const dayKey = (date) => {
  const d = toDate(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

const monthKey = (date) => dayKey(date).slice(0, 7);

// Validates a required date input and returns its start of day, or throws a 400.
const requireDay = (value, field) => {
  if (!value) throw new HttpError(400, `${field} is required`);
  const d = startOfDay(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid date`);
  return d;
};

// Validates an inclusive date range and returns { start, end } (end is end-of-day).
const requireRange = (from, to, fromField = 'periodStart', toField = 'periodEnd') => {
  const start = requireDay(from, fromField);
  const endStart = requireDay(to, toField);
  if (endStart < start) throw new HttpError(400, `${toField} must be on or after ${fromField}`);
  return { start, end: endOfDay(endStart) };
};

const monthRange = (year, month) => ({
  start: new Date(year, month - 1, 1),
  end: new Date(year, month, 0, 23, 59, 59, 999),
});

module.exports = {
  toDate,
  startOfDay,
  endOfDay,
  addDays,
  daysBetween,
  dayKey,
  monthKey,
  requireDay,
  requireRange,
  monthRange,
};
