const { invalid } = require('./errors');

// Attendance rules — pure functions, no I/O.
const STATUSES = ['present', 'absent', 'half', 'leave'];
const MAX_OT_HOURS = 16;
const UNITS = { present: 1, half: 0.5 };

const validateEntry = ({ status, otHours }) => {
  if (status && !STATUSES.includes(status)) throw invalid(`Invalid status "${status}"`);
  if (otHours !== undefined && otHours !== null && otHours !== '') {
    const ot = Number(otHours);
    if (!Number.isFinite(ot) || ot < 0 || ot > MAX_OT_HOURS) {
      throw invalid(`Overtime must be between 0 and ${MAX_OT_HOURS} hours`);
    }
  }
};

// Overtime only counts on days actually worked.
const otFor = (status, otHours) => (status === 'present' || status === 'half' ? Number(otHours) || 0 : 0);

// A person can earn at most one day's wage per date across all sites.
// elsewhere: { units, sites: [names] } already worked that day at other sites.
const exceedsOneDay = (status, elsewhere) => Boolean(elsewhere) && (UNITS[status] || 0) + elsewhere.units > 1;

// Why an entry can't be saved (or null). Order matters: assignment, payment lock, one-day rule.
const skipReason = ({ assigned, lockedBy, status, elsewhere }) => {
  if (!assigned) return 'Not assigned to this site';
  if (lockedBy) return `Day is already in a ${lockedBy} payment`;
  if (exceedsOneDay(status, elsewhere)) return `Already worked at ${elsewhere.sites.join(', ')} that day`;
  return null;
};

const summarize = (records) => {
  const summary = { present: 0, absent: 0, half: 0, leave: 0, otHours: 0 };
  records.forEach((r) => {
    summary[r.status] += 1;
    summary.otHours += r.otHours || 0;
  });
  summary.payableDays = summary.present + summary.half * 0.5;
  return summary;
};

module.exports = { STATUSES, MAX_OT_HOURS, UNITS, validateEntry, otFor, exceedsOneDay, skipReason, summarize };
