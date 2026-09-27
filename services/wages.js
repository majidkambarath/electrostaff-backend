const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const Advance = require('../models/Advance');
const Staff = require('../models/Staff');
const { HttpError } = require('../utils/http');
const { endOfDay, startOfDay, addDays, requireDay } = require('../utils/date');

const PAYABLE_STATUSES = ['present', 'half'];
const PAYABLE_UNITS = { present: 1, half: 0.5 };
const PAYMENT_MODES = ['cash', 'upi', 'bank'];

const payableUnits = (status) => PAYABLE_UNITS[status] || 0;

// Overtime rate per hour: the staff member's own rate, or a day's wage spread over 8 hours.
const otRateOf = (staff) =>
  staff.otRate !== undefined && staff.otRate !== null ? staff.otRate : Math.round((staff.dailyWage || 0) / 8);

// Wages for work at one site: day wages plus overtime, rounded per site so previews,
// payments, outstanding figures and reports always agree to the rupee.
const siteAmount = (staff, { presentDays = 0, halfDays = 0, otHours = 0 }) =>
  Math.round((staff.dailyWage || 0) * (presentDays + halfDays * 0.5) + otRateOf(staff) * otHours);

const netAmountOf = (payment) => payment.netAmount ?? payment.totalAmount;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const emptySite = () => ({ presentDays: 0, halfDays: 0, otHours: 0 });

const addRecord = (site, r) => {
  if (r.status === 'present') site.presentDays += 1;
  else if (r.status === 'half') site.halfDays += 1;
  site.otHours += r.otHours || 0;
};

// Wage breakdown by site for one staff member over [start, end].
const calcBreakdown = async (staff, start, end, organizationId) => {
  const records = await Attendance.find({
    staffId: staff._id,
    organizationId,
    date: { $gte: start, $lte: end },
    status: { $in: PAYABLE_STATUSES },
  })
    .select('siteId status otHours')
    .populate('siteId', 'name')
    .lean();

  const bySite = new Map();
  for (const r of records) {
    const sid = String(r.siteId?._id || r.siteId);
    if (!bySite.has(sid)) {
      bySite.set(sid, { siteId: r.siteId?._id || r.siteId, siteName: r.siteId?.name || 'Removed site', ...emptySite() });
    }
    addRecord(bySite.get(sid), r);
  }

  const otRate = otRateOf(staff);
  const breakdown = [...bySite.values()].map((item) => ({
    ...item,
    otAmount: Math.round(otRate * item.otHours),
    amount: siteAmount(staff, item),
  }));

  return {
    breakdown,
    otRate,
    totalDays: breakdown.reduce((s, b) => s + b.presentDays + b.halfDays * 0.5, 0),
    otHours: breakdown.reduce((s, b) => s + b.otHours, 0),
    otAmount: breakdown.reduce((s, b) => s + b.otAmount, 0),
    totalAmount: breakdown.reduce((s, b) => s + b.amount, 0),
  };
};

// Any payment (pending or paid) whose period overlaps [start, end] for this staff member.
const findOverlappingPayment = (staffId, start, end, organizationId, excludeId) => {
  const filter = {
    staffId,
    organizationId,
    periodStart: { $lte: end },
    periodEnd: { $gte: start },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Payment.findOne(filter).select('status periodStart periodEnd').lean();
};

// Map of staffId -> { given, recovered, balance } for advances.
const advanceBalances = async (organizationId, staffId) => {
  const match = { organizationId: toObjectId(organizationId) };
  if (staffId) match.staffId = toObjectId(staffId);

  const [given, recovered] = await Promise.all([
    Advance.aggregate([
      { $match: match },
      { $group: { _id: '$staffId', total: { $sum: '$amount' }, lastDate: { $max: '$date' } } },
    ]),
    Payment.aggregate([
      { $match: { ...match, advanceDeducted: { $gt: 0 } } },
      { $group: { _id: '$staffId', total: { $sum: '$advanceDeducted' } } },
    ]),
  ]);

  const map = new Map();
  for (const g of given) {
    map.set(String(g._id), { given: g.total, recovered: 0, balance: g.total, lastDate: g.lastDate });
  }
  for (const r of recovered) {
    const entry = map.get(String(r._id)) || { given: 0, recovered: 0, balance: 0 };
    entry.recovered = r.total;
    entry.balance = entry.given - r.total;
    map.set(String(r._id), entry);
  }
  return map;
};

const advanceBalanceFor = async (organizationId, staffId) =>
  (await advanceBalances(organizationId, staffId)).get(String(staffId))?.balance || 0;

const assertPaymentMode = (mode) => {
  if (!PAYMENT_MODES.includes(mode)) throw new HttpError(400, 'Choose a payment mode: cash, UPI or bank');
};

// Validates and creates one payment (pending, or paid when markPaid). Shared by single
// payments and payroll runs so both enforce the same rules.
const createPaymentFor = async ({
  organizationId,
  staff,
  start,
  end,
  bonus = 0,
  deductions = 0,
  advanceDeducted = 0,
  note,
  markPaid,
  paymentMode,
  paidDate,
  payrollRunId,
}) => {
  const overlap = await findOverlappingPayment(staff._id, start, end, organizationId);
  if (overlap) {
    const hint = overlap.status === 'pending' ? ' Mark it paid or cancel it first.' : '';
    throw new HttpError(409, `This period overlaps an existing ${overlap.status} payment.${hint}`);
  }

  const [calc, advanceBalance] = await Promise.all([
    calcBreakdown(staff, start, end, organizationId),
    advanceBalanceFor(organizationId, staff._id),
  ]);

  if (calc.totalDays === 0) throw new HttpError(400, 'No present or half days in this period to pay for');
  if (advanceDeducted > advanceBalance) {
    throw new HttpError(400, `Advance recovery can't exceed the outstanding advance of ₹${advanceBalance}`);
  }
  const netAmount = calc.totalAmount + bonus - deductions - advanceDeducted;
  if (netAmount < 0) throw new HttpError(400, 'Deductions and advance recovery exceed the wages for this period');
  if (markPaid) assertPaymentMode(paymentMode);

  return Payment.create({
    staffId: staff._id,
    periodStart: start,
    periodEnd: startOfDay(end),
    breakdown: calc.breakdown.map(({ siteId, presentDays, halfDays, otHours, otAmount, amount }) => ({
      siteId,
      presentDays,
      halfDays,
      otHours,
      otAmount,
      amount,
    })),
    dailyWage: staff.dailyWage,
    otRate: calc.otRate,
    otHours: calc.otHours,
    otAmount: calc.otAmount,
    totalDays: calc.totalDays,
    totalAmount: calc.totalAmount,
    bonus,
    deductions,
    advanceDeducted,
    netAmount,
    status: markPaid ? 'paid' : 'pending',
    paymentMode: markPaid ? paymentMode : undefined,
    paidDate: markPaid ? (paidDate ? requireDay(paidDate, 'paidDate') : new Date()) : undefined,
    note,
    payrollRunId,
    organizationId,
  });
};

// Labour cost from attendance, per site: Map siteId -> { cost, personDays, otHours, staff: Set }.
// Optional filters: siteId, start, end.
const labourCostBySite = async (organizationId, { siteId, start, end } = {}) => {
  const match = { organizationId: toObjectId(organizationId), status: { $in: PAYABLE_STATUSES } };
  if (siteId) match.siteId = toObjectId(siteId);
  if (start || end) match.date = { ...(start && { $gte: start }), ...(end && { $lte: end }) };

  const groups = await Attendance.aggregate([
    { $match: match },
    {
      $group: {
        _id: { siteId: '$siteId', staffId: '$staffId' },
        presentDays: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        halfDays: { $sum: { $cond: [{ $eq: ['$status', 'half'] }, 1, 0] } },
        otHours: { $sum: { $ifNull: ['$otHours', 0] } },
      },
    },
  ]);

  const staffIds = [...new Set(groups.map((g) => String(g._id.staffId)))];
  const staffDocs = await Staff.find({ _id: { $in: staffIds } }).select('dailyWage otRate').lean();
  const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));

  const result = new Map();
  for (const g of groups) {
    const sid = String(g._id.siteId);
    const staff = staffMap.get(String(g._id.staffId)) || { dailyWage: 0, otRate: 0 };
    const entry = result.get(sid) || { cost: 0, personDays: 0, otHours: 0, staff: new Set() };
    entry.cost += siteAmount(staff, g);
    entry.personDays += g.presentDays + g.halfDays * 0.5;
    entry.otHours += g.otHours;
    entry.staff.add(String(g._id.staffId));
    result.set(sid, entry);
  }
  return result;
};

// Present/half attendance not covered by any payment period (pending or paid), per staff.
// suggestedPeriod stops before the next existing payment so it can be paid without overlap.
const computeOutstanding = async (organizationId, { staffId } = {}) => {
  const attFilter = { organizationId, status: { $in: PAYABLE_STATUSES } };
  const payFilter = { organizationId };
  if (staffId) {
    attFilter.staffId = staffId;
    payFilter.staffId = staffId;
  }

  const [records, payments] = await Promise.all([
    Attendance.find(attFilter).select('staffId siteId date status otHours').sort({ date: 1 }).lean(),
    Payment.find(payFilter).select('staffId periodStart periodEnd').lean(),
  ]);

  const periodsByStaff = new Map();
  for (const p of payments) {
    const sid = String(p.staffId);
    if (!periodsByStaff.has(sid)) periodsByStaff.set(sid, []);
    periodsByStaff.get(sid).push({ start: p.periodStart, end: endOfDay(p.periodEnd) });
  }

  const byStaff = new Map();
  for (const r of records) {
    const sid = String(r.staffId);
    const periods = periodsByStaff.get(sid) || [];
    if (periods.some((p) => r.date >= p.start && r.date <= p.end)) continue;

    if (!byStaff.has(sid)) byStaff.set(sid, { from: r.date, to: r.date, sites: new Map() });
    const entry = byStaff.get(sid);
    entry.to = r.date;
    const siteKey = String(r.siteId);
    const site = entry.sites.get(siteKey) || emptySite();
    addRecord(site, r);
    entry.sites.set(siteKey, site);
  }

  if (byStaff.size === 0) return [];

  const [staffDocs, balances] = await Promise.all([
    Staff.find({ _id: { $in: [...byStaff.keys()] } }).select('name role phone dailyWage otRate status').lean(),
    advanceBalances(organizationId, staffId),
  ]);
  const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));

  const rows = [];
  for (const [sid, entry] of byStaff) {
    const staff = staffMap.get(sid);
    if (!staff) continue;
    let presentDays = 0;
    let halfDays = 0;
    let otHours = 0;
    let amount = 0;
    for (const site of entry.sites.values()) {
      presentDays += site.presentDays;
      halfDays += site.halfDays;
      otHours += site.otHours;
      amount += siteAmount(staff, site);
    }

    const nextPaymentStart = (periodsByStaff.get(sid) || [])
      .map((p) => p.start)
      .filter((d) => d > entry.from && d <= entry.to)
      .sort((a, b) => a - b)[0];

    rows.push({
      staff,
      presentDays,
      halfDays,
      otHours,
      payableDays: presentDays + halfDays * 0.5,
      amount,
      from: entry.from,
      to: entry.to,
      suggestedPeriod: {
        start: entry.from,
        end: nextPaymentStart ? addDays(nextPaymentStart, -1) : entry.to,
      },
      advanceBalance: balances.get(sid)?.balance || 0,
    });
  }

  return rows.sort((a, b) => b.amount - a.amount);
};

module.exports = {
  PAYABLE_STATUSES,
  PAYMENT_MODES,
  payableUnits,
  otRateOf,
  siteAmount,
  netAmountOf,
  toObjectId,
  calcBreakdown,
  findOverlappingPayment,
  advanceBalances,
  advanceBalanceFor,
  assertPaymentMode,
  createPaymentFor,
  labourCostBySite,
  computeOutstanding,
};
