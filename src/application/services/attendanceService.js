const { requireId } = require('../validation');
const { invalid, notFound } = require('../../domain/errors');
const { endOfDay, requireDay, requireRange, monthRange, isFutureDay } = require('../../domain/dates');
const { validateEntry, otFor, skipReason, summarize, UNITS } = require('../../domain/attendance');

module.exports = ({ attendanceRepo, assignmentRepo, siteRepo, leaveRepo, paymentRepo }) => {
  // staffId -> { units, sites } already worked on `day` at other sites.
  const workedElsewhere = async (orgId, staffIds, day, siteId) => {
    const map = new Map();
    for (const r of await attendanceRepo.payableElsewhere(orgId, staffIds, day, siteId)) {
      const sid = String(r.staffId);
      const prev = map.get(sid) || { units: 0, sites: [], records: [] };
      prev.units += UNITS[r.status] || 0;
      prev.sites.push(r.siteId?.name || 'another site');
      prev.records.push({ siteName: r.siteId?.name || 'Another site', status: r.status });
      map.set(sid, prev);
    }
    return map;
  };

  // Everyone assigned to a site with their mark for the day, approved leave, payment lock
  // and work at other sites that day.
  const siteDay = async (orgId, siteId, date) => {
    requireId(siteId, 'siteId');
    const day = requireDay(date, 'date');
    const assigned = await assignmentRepo.listForSite(orgId, siteId, 'name phone role dailyWage status');
    const staffIds = assigned.map((a) => a.staffId._id);

    const [records, leaves, locked, elsewhere] = await Promise.all([
      attendanceRepo.forSiteDay(orgId, siteId, day),
      leaveRepo.approvedTypesForDay(orgId, staffIds, day, endOfDay(day)),
      paymentRepo.coveringDay(orgId, staffIds, day, endOfDay(day)),
      workedElsewhere(orgId, staffIds, day, siteId),
    ]);
    const recordMap = new Map(records.map((r) => [String(r.staffId), r]));

    return {
      date: day,
      siteId,
      records: assigned.map((a) => {
        const sid = String(a.staffId._id);
        return {
          staff: a.staffId,
          attendance: recordMap.get(sid) || null,
          leaveType: leaves.get(sid) || null,
          lockedBy: locked.get(sid) || null,
          elsewhere: elsewhere.get(sid)?.records || [],
        };
      }),
    };
  };

  // Upserts (or clears, when status is empty) attendance for many staff at one site and day.
  // Entries that break a rule are skipped and reported, never partially applied.
  const save = async (orgId, siteId, date, entries, { source = 'admin' } = {}) => {
    requireId(siteId, 'siteId');
    const day = requireDay(date, 'date');
    if (isFutureDay(day)) throw invalid('Attendance cannot be marked for a future date');
    if (!Array.isArray(entries) || entries.length === 0) throw invalid('records must be a non-empty array');
    entries.forEach((e) => {
      requireId(e.staffId, 'staffId');
      validateEntry(e);
    });
    if (!(await siteRepo.exists(orgId, siteId))) throw notFound('Site');

    const staffIds = entries.map((e) => e.staffId);
    const [assignedIds, locked, elsewhere] = await Promise.all([
      assignmentRepo.assignedStaffIds(orgId, siteId, staffIds),
      paymentRepo.coveringDay(orgId, staffIds, day, endOfDay(day)),
      workedElsewhere(orgId, staffIds, day, siteId),
    ]);

    const skipped = [];
    const writes = [];
    for (const entry of entries) {
      const sid = String(entry.staffId);
      const reason = skipReason({
        assigned: assignedIds.has(sid),
        lockedBy: locked.get(sid),
        status: entry.status,
        elsewhere: elsewhere.get(sid),
      });
      if (reason) {
        skipped.push({ staffId: entry.staffId, reason });
        continue;
      }
      writes.push({
        staffId: entry.staffId,
        status: entry.status || '',
        otHours: otFor(entry.status, entry.otHours),
        source,
        checkIn: entry.checkIn,
      });
    }
    if (writes.length) await attendanceRepo.saveDay(orgId, siteId, day, writes);
    return { saved: writes.length, skipped, day };
  };

  return {
    siteDay,
    save,

    markOne: async (orgId, { staffId, siteId, date, status, otHours }) => {
      const result = await save(orgId, siteId, date, [{ staffId, status, otHours }]);
      if (result.skipped.length) throw invalid(result.skipped[0].reason);
      return { saved: result.saved, skipped: [] };
    },

    bulk: async (orgId, { siteId, date, records }) => {
      const { saved, skipped } = await save(orgId, siteId, date, records);
      return { saved, skipped };
    },

    staffHistory: async (orgId, staffId, { siteId, month, year, from, to } = {}) => {
      requireId(staffId, 'staffId');
      let range = {};
      if (from && to) range = requireRange(from, to, 'from', 'to');
      else if (month && year) range = monthRange(Number(year), Number(month));
      const records = await attendanceRepo.listForStaff(orgId, staffId, { siteId, ...range });
      return { records, summary: summarize(records) };
    },
  };
};
