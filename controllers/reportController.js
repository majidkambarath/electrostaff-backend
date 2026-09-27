const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const Advance = require('../models/Advance');
const Expense = require('../models/Expense');
const ClientReceipt = require('../models/ClientReceipt');
const Staff = require('../models/Staff');
const Site = require('../models/Site');
const SiteAssignment = require('../models/SiteAssignment');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, requireId } = require('../utils/http');
const { requireRange, monthRange, dayKey } = require('../utils/date');
const { siteAmount, netAmountOf, otRateOf, toObjectId } = require('../services/wages');
const { sumBySite } = require('../services/finance');

const emptyCounts = () => ({ present: 0, half: 0, absent: 0, leave: 0, otHours: 0 });

const addCounts = (target, c) => {
  Object.keys(c).forEach((k) => {
    target[k] += c[k];
  });
};

// Wage & money report for [from, to], grouped by staff and by site.
// earned = attendance x current wage (+ overtime); paid, advances, expenses and receipts are cash in the range.
exports.getSummary = asyncHandler(async (req, res) => {
  const { start, end } = requireRange(req.query.from, req.query.to, 'from', 'to');
  const org = req.organizationId;
  const range = { start, end };

  const [records, payments, advances, expensesBySite, receiptsBySite, generalExpenses] = await Promise.all([
    Attendance.find({ organizationId: org, date: { $gte: start, $lte: end } })
      .select('staffId siteId status otHours')
      .lean(),
    Payment.find({ organizationId: org, status: 'paid', paidDate: { $gte: start, $lte: end } })
      .select('staffId totalAmount netAmount advanceDeducted')
      .lean(),
    Advance.find({ organizationId: org, date: { $gte: start, $lte: end } }).select('staffId amount').lean(),
    sumBySite(Expense, org, range),
    sumBySite(ClientReceipt, org, range),
    Expense.aggregate([
      { $match: { organizationId: toObjectId(org), siteId: null, date: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const staffIds = new Set([
    ...records.map((r) => String(r.staffId)),
    ...payments.map((p) => String(p.staffId)),
    ...advances.map((a) => String(a.staffId)),
  ]);
  const siteIds = new Set([...records.map((r) => String(r.siteId)), ...expensesBySite.keys(), ...receiptsBySite.keys()]);

  const [staffDocs, siteDocs] = await Promise.all([
    Staff.find({ _id: { $in: [...staffIds] } }).select('name role phone dailyWage otRate status').lean(),
    Site.find({ _id: { $in: [...siteIds] } }).select('name clientName status contractValue').lean(),
  ]);
  const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));
  const siteMap = new Map(siteDocs.map((s) => [String(s._id), s]));

  // staff -> site -> counts, so amounts round per site exactly like payments do
  const matrix = new Map();
  for (const r of records) {
    const sid = String(r.staffId);
    const site = String(r.siteId);
    if (!matrix.has(sid)) matrix.set(sid, new Map());
    const bySite = matrix.get(sid);
    if (!bySite.has(site)) bySite.set(site, emptyCounts());
    const c = bySite.get(site);
    c[r.status] += 1;
    if (r.status === 'present' || r.status === 'half') c.otHours += r.otHours || 0;
  }

  const staffRows = new Map();
  const siteRows = new Map();
  const staffRow = (sid) => {
    if (!staffRows.has(sid)) {
      staffRows.set(sid, { staff: staffMap.get(sid), ...emptyCounts(), payableDays: 0, otAmount: 0, earned: 0, paid: 0, advances: 0, advanceRecovered: 0 });
    }
    return staffRows.get(sid);
  };
  const siteRow = (site) => {
    if (!siteRows.has(site)) {
      siteRows.set(site, { site: siteMap.get(site) || { _id: site, name: 'Removed site' }, ...emptyCounts(), staff: new Set(), personDays: 0, labourCost: 0 });
    }
    return siteRows.get(site);
  };

  for (const [sid, bySite] of matrix) {
    const staff = staffMap.get(sid) || { dailyWage: 0 };
    const row = staffRow(sid);
    for (const [site, c] of bySite) {
      const amount = siteAmount(staff, { presentDays: c.present, halfDays: c.half, otHours: c.otHours });
      const days = c.present + c.half * 0.5;
      addCounts(row, c);
      row.payableDays += days;
      row.otAmount += Math.round(otRateOf(staff) * c.otHours);
      row.earned += amount;

      const sr = siteRow(site);
      addCounts(sr, c);
      sr.staff.add(sid);
      sr.personDays += days;
      sr.labourCost += amount;
    }
  }

  for (const p of payments) {
    const row = staffRow(String(p.staffId));
    row.paid += netAmountOf(p);
    row.advanceRecovered += p.advanceDeducted || 0;
  }
  for (const a of advances) staffRow(String(a.staffId)).advances += a.amount;
  for (const site of siteIds) siteRow(site);

  const byStaff = [...staffRows.values()].filter((r) => r.staff).sort((a, b) => b.earned - a.earned);
  const bySite = [...siteRows.entries()]
    .map(([id, { staff, ...rest }]) => {
      const expenses = expensesBySite.get(id) || 0;
      const received = receiptsBySite.get(id) || 0;
      return {
        ...rest,
        staffCount: staff.size,
        expenses,
        received,
        totalCost: rest.labourCost + expenses,
        net: received - rest.labourCost - expenses,
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost);

  const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
  const siteExpenses = sum(bySite, 'expenses');
  const general = generalExpenses[0]?.total || 0;
  res.json({
    from: start,
    to: end,
    totals: {
      staffCount: byStaff.filter((r) => r.payableDays > 0).length,
      siteCount: bySite.length,
      payableDays: sum(byStaff, 'payableDays'),
      otHours: sum(byStaff, 'otHours'),
      earned: sum(byStaff, 'earned'),
      paid: sum(byStaff, 'paid'),
      advances: sum(byStaff, 'advances'),
      siteExpenses,
      generalExpenses: general,
      expenses: siteExpenses + general,
      received: sum(bySite, 'received'),
    },
    byStaff,
    bySite,
  });
});

// Monthly attendance register (muster roll): one row per staff member, one cell per day.
// With siteId it covers that site's team; without it, every site (a day may hold several records).
exports.getMuster = asyncHandler(async (req, res) => {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) throw new HttpError(400, 'Valid month and year are required');
  const { siteId } = req.query;
  if (siteId) requireId(siteId, 'siteId');
  const { start, end } = monthRange(year, month);

  const attFilter = { organizationId: req.organizationId, date: { $gte: start, $lte: end } };
  if (siteId) attFilter.siteId = siteId;

  const [records, site, assigned] = await Promise.all([
    Attendance.find(attFilter).populate('siteId', 'name').select('staffId siteId date status otHours').lean(),
    siteId ? Site.findOne({ _id: siteId, organizationId: req.organizationId }).lean() : null,
    siteId
      ? SiteAssignment.find({ siteId, active: true, organizationId: req.organizationId }).select('staffId').lean()
      : Staff.find(orgOrLegacy(req, { status: { $ne: 'inactive' } })).select('_id').lean(),
  ]);
  if (siteId && !site) throw new HttpError(404, 'Site not found');

  const ids = new Set([
    ...records.map((r) => String(r.staffId)),
    ...assigned.map((a) => String(a.staffId || a._id)),
  ]);
  const staffDocs = await Staff.find({ _id: { $in: [...ids] } }).select('name role phone dailyWage').lean();

  const rows = new Map(
    staffDocs.map((s) => [String(s._id), { staff: s, days: {}, totals: { ...emptyCounts(), payableDays: 0 } }])
  );
  for (const r of records) {
    const row = rows.get(String(r.staffId));
    if (!row) continue;
    const key = dayKey(r.date).slice(8).replace(/^0/, '');
    (row.days[key] ||= []).push({ status: r.status, otHours: r.otHours || 0, site: r.siteId?.name || '' });
    row.totals[r.status] += 1;
    if (r.status === 'present' || r.status === 'half') row.totals.otHours += r.otHours || 0;
  }
  rows.forEach((row) => {
    row.totals.payableDays = row.totals.present + row.totals.half * 0.5;
  });

  res.json({
    month,
    year,
    daysInMonth: new Date(year, month, 0).getDate(),
    site: site ? { _id: site._id, name: site.name, clientName: site.clientName } : null,
    rows: [...rows.values()].sort((a, b) => a.staff.name.localeCompare(b.staff.name)),
  });
});
