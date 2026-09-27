const Site = require('../models/Site');
const SiteAssignment = require('../models/SiteAssignment');
const Attendance = require('../models/Attendance');
const Staff = require('../models/Staff');
const Expense = require('../models/Expense');
const ClientReceipt = require('../models/ClientReceipt');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, pick, requireId } = require('../utils/http');
const { startOfDay, addDays, dayKey } = require('../utils/date');
const { siteAmount, toObjectId, labourCostBySite } = require('../services/wages');
const { sumBySite, financeSummary } = require('../services/finance');

const SITE_FIELDS = [
  'name',
  'address',
  'clientName',
  'clientPhone',
  'startDate',
  'endDate',
  'status',
  'notes',
  'contractValue',
];

const findSite = async (req) => {
  const site = await Site.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!site) throw new HttpError(404, 'Site not found');
  return site;
};

exports.getSites = asyncHandler(async (req, res) => {
  const orgId = toObjectId(req.organizationId);
  const today = startOfDay(new Date());

  const [sites, staffCounts, todayCounts, labour, received, expenses] = await Promise.all([
    Site.find({ organizationId: req.organizationId }).sort({ createdAt: -1 }).lean(),
    SiteAssignment.aggregate([
      { $match: { organizationId: orgId, active: true } },
      { $group: { _id: '$siteId', count: { $sum: 1 } } },
    ]),
    Attendance.aggregate([
      { $match: { organizationId: orgId, date: today } },
      {
        $group: {
          _id: '$siteId',
          marked: { $sum: 1 },
          present: { $sum: { $cond: [{ $in: ['$status', ['present', 'half']] }, 1, 0] } },
        },
      },
    ]),
    labourCostBySite(req.organizationId),
    sumBySite(ClientReceipt, req.organizationId),
    sumBySite(Expense, req.organizationId),
  ]);

  const staffMap = new Map(staffCounts.map((c) => [String(c._id), c.count]));
  const todayMap = new Map(todayCounts.map((c) => [String(c._id), c]));

  res.json(
    sites.map((site) => {
      const id = String(site._id);
      return {
        ...site,
        staffCount: staffMap.get(id) || 0,
        markedToday: todayMap.get(id)?.marked || 0,
        presentToday: todayMap.get(id)?.present || 0,
        finance: financeSummary({
          contractValue: site.contractValue || 0,
          received: received.get(id) || 0,
          labourCost: labour.get(id)?.cost || 0,
          expenses: expenses.get(id) || 0,
        }),
      };
    })
  );
});

exports.getSiteById = asyncHandler(async (req, res) => {
  const site = await findSite(req);
  const staffCount = await SiteAssignment.countDocuments({
    siteId: site._id,
    active: true,
    organizationId: req.organizationId,
  });
  res.json({ ...site.toObject(), staffCount });
});

exports.createSite = asyncHandler(async (req, res) => {
  const site = await Site.create({ ...pick(req.body, SITE_FIELDS), organizationId: req.organizationId });
  res.status(201).json(site);
});

exports.updateSite = asyncHandler(async (req, res) => {
  const body = pick(req.body, SITE_FIELDS);
  if (body.endDate === '') body.endDate = null;
  const site = await Site.findOneAndUpdate(
    { _id: req.params.id, organizationId: req.organizationId },
    body,
    { new: true, runValidators: true }
  );
  if (!site) throw new HttpError(404, 'Site not found');
  res.json(site);
});

// Sites with attendance or money history are archived as completed rather than deleted.
exports.deleteSite = asyncHandler(async (req, res) => {
  const site = await findSite(req);
  const [hasAttendance, hasReceipts, hasExpenses] = await Promise.all([
    Attendance.exists({ siteId: site._id, organizationId: req.organizationId }),
    ClientReceipt.exists({ siteId: site._id }),
    Expense.exists({ siteId: site._id }),
  ]);

  if (hasAttendance || hasReceipts || hasExpenses) {
    site.status = 'completed';
    await site.save();
    await SiteAssignment.updateMany({ siteId: site._id }, { active: false });
    return res.json({ archived: true, message: 'Site has history, so it was marked completed', site });
  }

  await SiteAssignment.deleteMany({ siteId: site._id, organizationId: req.organizationId });
  await site.deleteOne();
  res.json({ archived: false, message: 'Site deleted' });
});

exports.getSiteStaff = asyncHandler(async (req, res) => {
  const assignments = await SiteAssignment.find({
    siteId: req.params.id,
    active: true,
    organizationId: req.organizationId,
  })
    .populate('staffId', 'name phone role dailyWage status')
    .sort({ assignedDate: -1 })
    .lean();
  res.json(assignments.filter((a) => a.staffId));
});

// Accepts { staffId } or { staffIds: [] }.
exports.assignStaff = asyncHandler(async (req, res) => {
  const site = await findSite(req);
  if (site.status === 'completed') throw new HttpError(400, 'Reopen this site before assigning staff');

  const ids = (req.body.staffIds || [req.body.staffId]).filter(Boolean);
  if (ids.length === 0) throw new HttpError(400, 'Select at least one staff member');
  ids.forEach((id) => requireId(id, 'staffId'));

  const staff = await Staff.find(orgOrLegacy(req, { _id: { $in: ids } })).select('_id status').lean();
  if (staff.length !== ids.length) throw new HttpError(404, 'One or more staff members were not found');
  if (staff.some((s) => s.status === 'inactive')) {
    throw new HttpError(400, 'Inactive staff cannot be assigned. Reactivate them first.');
  }

  await SiteAssignment.bulkWrite(
    ids.map((staffId) => ({
      updateOne: {
        filter: { staffId, siteId: site._id },
        update: {
          $set: { active: true, organizationId: req.organizationId },
          $setOnInsert: { assignedDate: new Date() },
        },
        upsert: true,
      },
    }))
  );

  const assignments = await SiteAssignment.find({ siteId: site._id, staffId: { $in: ids } })
    .populate('staffId', 'name phone role dailyWage status')
    .lean();
  res.status(201).json(assignments);
});

exports.unassignStaff = asyncHandler(async (req, res) => {
  const assignment = await SiteAssignment.findOneAndUpdate(
    { siteId: req.params.id, staffId: req.params.staffId, organizationId: req.organizationId },
    { active: false },
    { new: true }
  );
  if (!assignment) throw new HttpError(404, 'Assignment not found');
  res.json({ message: 'Staff unassigned', assignment });
});

exports.getSiteProgress = asyncHandler(async (req, res) => {
  const site = await findSite(req);
  const today = startOfDay(new Date());
  const trendStart = addDays(today, -13);

  const [assignments, allRecords] = await Promise.all([
    SiteAssignment.find({ siteId: site._id, active: true, organizationId: req.organizationId })
      .populate('staffId', 'name phone role dailyWage otRate')
      .lean(),
    Attendance.find({ siteId: site._id, organizationId: req.organizationId })
      .select('staffId date status otHours')
      .lean(),
  ]);

  const staffMap = new Map();
  const assignedStaff = assignments.filter((a) => a.staffId);
  assignedStaff.forEach((a) => staffMap.set(String(a.staffId._id), a.staffId));

  // Wages of staff no longer assigned still count toward the site's labour cost.
  const missingIds = [...new Set(allRecords.map((r) => String(r.staffId)))].filter((id) => !staffMap.has(id));
  if (missingIds.length) {
    const others = await Staff.find({ _id: { $in: missingIds } }).select('dailyWage otRate').lean();
    others.forEach((s) => staffMap.set(String(s._id), s));
  }

  const emptyRow = () => ({ present: 0, absent: 0, half: 0, leave: 0, otHours: 0, totalMarked: 0 });
  const perStaff = new Map();
  const trend = new Map();
  for (let i = 0; i < 14; i++) {
    const d = addDays(trendStart, i);
    trend.set(dayKey(d), { date: dayKey(d), present: 0, half: 0, absent: 0, leave: 0 });
  }

  let markedToday = 0;
  for (const r of allRecords) {
    const sid = String(r.staffId);
    if (!perStaff.has(sid)) perStaff.set(sid, emptyRow());
    const row = perStaff.get(sid);
    row[r.status] += 1;
    row.otHours += r.otHours || 0;
    row.totalMarked += 1;
    if (r.date.getTime() === today.getTime()) markedToday += 1;
    const t = trend.get(dayKey(r.date));
    if (t) t[r.status] += 1;
  }

  const earnedFor = (staff, row) =>
    siteAmount(staff || { dailyWage: 0 }, { presentDays: row.present, halfDays: row.half, otHours: row.otHours });

  let labourCost = 0;
  let personDays = 0;
  let otHours = 0;
  for (const [sid, row] of perStaff) {
    labourCost += earnedFor(staffMap.get(sid), row);
    personDays += row.present + row.half * 0.5;
    otHours += row.otHours;
  }

  const staffProgress = assignedStaff.map((a) => {
    const row = perStaff.get(String(a.staffId._id)) || emptyRow();
    return {
      staff: a.staffId,
      ...row,
      payableDays: row.present + row.half * 0.5,
      earned: earnedFor(a.staffId, row),
    };
  });

  const totalStaff = assignedStaff.length;
  const daysElapsed = Math.max(1, Math.round((today - startOfDay(site.startDate)) / 86400000) + 1);

  res.json({
    site,
    summary: {
      totalStaff,
      markedToday,
      daysElapsed,
      personDays,
      otHours,
      labourCost,
      attendanceTodayRate: totalStaff ? Math.round((markedToday / totalStaff) * 100) : 0,
    },
    staffProgress,
    trend: [...trend.values()],
  });
});

// Money view of a site: contract, client receipts, expenses by category, labour cost and profit.
exports.getSiteFinance = asyncHandler(async (req, res) => {
  const site = await findSite(req);
  const [labour, receipts, expenses] = await Promise.all([
    labourCostBySite(req.organizationId, { siteId: site._id }),
    ClientReceipt.find({ siteId: site._id, organizationId: req.organizationId }).sort({ date: -1 }).lean(),
    Expense.find({ siteId: site._id, organizationId: req.organizationId }).sort({ date: -1 }).lean(),
  ]);

  const byCategory = new Map();
  expenses.forEach((e) => byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount));
  const labourEntry = labour.get(String(site._id));

  res.json({
    site,
    summary: financeSummary({
      contractValue: site.contractValue || 0,
      received: receipts.reduce((s, r) => s + r.amount, 0),
      labourCost: labourEntry?.cost || 0,
      expenses: expenses.reduce((s, e) => s + e.amount, 0),
    }),
    personDays: labourEntry?.personDays || 0,
    costBreakdown: [
      { category: 'labour', amount: labourEntry?.cost || 0 },
      ...[...byCategory.entries()].map(([category, amount]) => ({ category, amount })),
    ].sort((a, b) => b.amount - a.amount),
    receipts,
    expenses,
  });
});
