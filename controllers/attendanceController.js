const Attendance = require('../models/Attendance');
const SiteAssignment = require('../models/SiteAssignment');
const Site = require('../models/Site');
const Leave = require('../models/Leave');
const Payment = require('../models/Payment');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, requireId } = require('../utils/http');
const { startOfDay, endOfDay, requireDay, monthRange, requireRange } = require('../utils/date');

const STATUSES = ['present', 'absent', 'half', 'leave'];

const assertNotFuture = (day) => {
  if (day > startOfDay(new Date())) throw new HttpError(400, 'Attendance cannot be marked for a future date');
};

// staffId -> payment status for staff whose wages for `day` are already in a payment.
const lockedStaffForDay = async (staffIds, day, organizationId) => {
  const payments = await Payment.find({
    organizationId,
    staffId: { $in: staffIds },
    periodStart: { $lte: endOfDay(day) },
    periodEnd: { $gte: day },
  })
    .select('staffId status')
    .lean();
  return new Map(payments.map((p) => [String(p.staffId), p.status]));
};

const approvedLeavesForDay = async (req, staffIds, day) => {
  const leaves = await Leave.find(
    orgOrLegacy(req, {
      staff: { $in: staffIds },
      status: 'approved',
      startDate: { $lte: endOfDay(day) },
      endDate: { $gte: day },
    })
  )
    .select('staff type')
    .lean();
  return new Map(leaves.map((l) => [String(l.staff), l.type]));
};

exports.getAttendance = asyncHandler(async (req, res) => {
  requireId(req.query.siteId, 'siteId');
  const day = requireDay(req.query.date, 'date');
  const { siteId } = req.query;

  const assignments = await SiteAssignment.find({ siteId, active: true, organizationId: req.organizationId })
    .populate('staffId', 'name phone role dailyWage status')
    .lean();
  const assigned = assignments.filter((a) => a.staffId);
  const staffIds = assigned.map((a) => a.staffId._id);

  const [records, leaves, locked, otherSites] = await Promise.all([
    Attendance.find({ siteId, date: day, organizationId: req.organizationId }).lean(),
    approvedLeavesForDay(req, staffIds, day),
    lockedStaffForDay(staffIds, day, req.organizationId),
    Attendance.find({
      organizationId: req.organizationId,
      staffId: { $in: staffIds },
      date: day,
      siteId: { $ne: siteId },
      status: { $in: ['present', 'half'] },
    })
      .populate('siteId', 'name')
      .lean(),
  ]);

  const recordMap = new Map(records.map((r) => [String(r.staffId), r]));
  const elsewhereMap = new Map();
  for (const r of otherSites) {
    const sid = String(r.staffId);
    if (!elsewhereMap.has(sid)) elsewhereMap.set(sid, []);
    elsewhereMap.get(sid).push({ siteName: r.siteId?.name || 'Another site', status: r.status });
  }

  res.json({
    date: day,
    siteId,
    records: assigned.map((a) => {
      const sid = String(a.staffId._id);
      return {
        staff: a.staffId,
        attendance: recordMap.get(sid) || null,
        leaveType: leaves.get(sid) || null,
        lockedBy: locked.get(sid) || null,
        elsewhere: elsewhereMap.get(sid) || [],
      };
    }),
  });
});

const validateEntry = ({ status, otHours }) => {
  if (status && !STATUSES.includes(status)) throw new HttpError(400, `Invalid status "${status}"`);
  if (otHours !== undefined && otHours !== null && otHours !== '') {
    const ot = Number(otHours);
    if (!Number.isFinite(ot) || ot < 0 || ot > 16) throw new HttpError(400, 'Overtime must be between 0 and 16 hours');
  }
};

// Overtime only counts on days actually worked.
const otFor = (status, otHours) => (status === 'present' || status === 'half' ? Number(otHours) || 0 : 0);

// Upserts (or clears, when status is empty) attendance for many staff at one site and day.
// Staff not assigned to the site, or whose day is already in a payment, are skipped and reported.
const saveEntries = async (req, siteId, day, entries) => {
  requireId(siteId, 'siteId');
  assertNotFuture(day);
  entries.forEach((e) => {
    requireId(e.staffId, 'staffId');
    validateEntry(e);
  });

  const site = await Site.findOne({ _id: siteId, organizationId: req.organizationId }).select('_id').lean();
  if (!site) throw new HttpError(404, 'Site not found');

  const staffIds = entries.map((e) => e.staffId);
  const [assignments, locked, otherSites] = await Promise.all([
    SiteAssignment.find({ siteId, active: true, staffId: { $in: staffIds }, organizationId: req.organizationId })
      .select('staffId')
      .lean(),
    lockedStaffForDay(staffIds, day, req.organizationId),
    Attendance.find({
      organizationId: req.organizationId,
      staffId: { $in: staffIds },
      date: day,
      siteId: { $ne: siteId },
      status: { $in: ['present', 'half'] },
    })
      .populate('siteId', 'name')
      .lean(),
  ]);
  const assignedIds = new Set(assignments.map((a) => String(a.staffId)));

  // A person can earn at most one day's wage per date across all sites.
  const elsewhere = new Map();
  for (const r of otherSites) {
    const sid = String(r.staffId);
    const prev = elsewhere.get(sid) || { units: 0, sites: [] };
    prev.units += r.status === 'present' ? 1 : 0.5;
    prev.sites.push(r.siteId?.name || 'another site');
    elsewhere.set(sid, prev);
  }
  const units = { present: 1, half: 0.5 };

  const skipped = [];
  const ops = [];
  for (const { staffId, status, otHours } of entries) {
    const sid = String(staffId);
    if (!assignedIds.has(sid)) {
      skipped.push({ staffId, reason: 'Not assigned to this site' });
      continue;
    }
    if (locked.has(sid)) {
      skipped.push({ staffId, reason: `Day is already in a ${locked.get(sid)} payment` });
      continue;
    }
    const other = elsewhere.get(sid);
    if (other && (units[status] || 0) + other.units > 1) {
      skipped.push({ staffId, reason: `Already worked at ${other.sites.join(', ')} that day` });
      continue;
    }
    const filter = { staffId, siteId, date: day, organizationId: req.organizationId };
    ops.push(
      status
        ? { updateOne: { filter, update: { $set: { status, otHours: otFor(status, otHours) } }, upsert: true } }
        : { deleteOne: { filter } }
    );
  }

  if (ops.length) await Attendance.bulkWrite(ops);
  return { saved: ops.length, skipped };
};

exports.markAttendance = asyncHandler(async (req, res) => {
  const { staffId, siteId, date, status, otHours } = req.body;
  const day = requireDay(date, 'date');
  const result = await saveEntries(req, siteId, day, [{ staffId, status, otHours }]);
  if (result.skipped.length) throw new HttpError(400, result.skipped[0].reason);
  res.status(201).json(result);
});

exports.bulkMarkAttendance = asyncHandler(async (req, res) => {
  const { siteId, date, records } = req.body;
  if (!Array.isArray(records) || records.length === 0) throw new HttpError(400, 'records must be a non-empty array');
  const day = requireDay(date, 'date');
  res.status(201).json(await saveEntries(req, siteId, day, records));
});

exports.getStaffAttendance = asyncHandler(async (req, res) => {
  const { siteId, month, year, from, to } = req.query;
  const filter = { staffId: req.params.staffId, organizationId: req.organizationId };
  if (siteId) filter.siteId = siteId;

  if (from && to) {
    const { start, end } = requireRange(from, to, 'from', 'to');
    filter.date = { $gte: start, $lte: end };
  } else if (month && year) {
    const { start, end } = monthRange(Number(year), Number(month));
    filter.date = { $gte: start, $lte: end };
  }

  const records = await Attendance.find(filter)
    .populate('siteId', 'name address status')
    .sort({ date: -1 })
    .lean();

  const summary = { present: 0, absent: 0, half: 0, leave: 0, otHours: 0 };
  records.forEach((r) => {
    summary[r.status] += 1;
    summary.otHours += r.otHours || 0;
  });
  summary.payableDays = summary.present + summary.half * 0.5;

  res.json({ records, summary });
});
