const PayrollRun = require('../models/PayrollRun');
const Payment = require('../models/Payment');
const Attendance = require('../models/Attendance');
const Staff = require('../models/Staff');
const Organization = require('../models/Organization');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, requireId, toNumber } = require('../utils/http');
const { requireRange, startOfDay } = require('../utils/date');
const {
  PAYABLE_STATUSES,
  advanceBalances,
  assertPaymentMode,
  createPaymentFor,
  otRateOf,
  siteAmount,
  toObjectId,
} = require('../services/wages');

// Everyone with payable attendance in [from, to]: wages per site, advance balance, and
// whether an existing payment already overlaps the period (those can't be included).
exports.previewPayroll = asyncHandler(async (req, res) => {
  const { start, end } = requireRange(req.query.from, req.query.to, 'from', 'to');
  const org = req.organizationId;

  const [records, overlapping, balances] = await Promise.all([
    Attendance.find({ organizationId: org, date: { $gte: start, $lte: end }, status: { $in: PAYABLE_STATUSES } })
      .select('staffId siteId status otHours')
      .populate('siteId', 'name')
      .lean(),
    Payment.find({ organizationId: org, periodStart: { $lte: end }, periodEnd: { $gte: start } })
      .select('staffId status periodStart periodEnd')
      .lean(),
    advanceBalances(org),
  ]);

  const byStaff = new Map();
  for (const r of records) {
    const sid = String(r.staffId);
    if (!byStaff.has(sid)) byStaff.set(sid, new Map());
    const sites = byStaff.get(sid);
    const key = String(r.siteId?._id || r.siteId);
    const site = sites.get(key) || { siteId: key, siteName: r.siteId?.name || 'Removed site', presentDays: 0, halfDays: 0, otHours: 0 };
    if (r.status === 'present') site.presentDays += 1;
    else site.halfDays += 1;
    site.otHours += r.otHours || 0;
    sites.set(key, site);
  }

  const staffDocs = await Staff.find({ _id: { $in: [...byStaff.keys()] } })
    .select('name role phone dailyWage otRate status')
    .lean();
  const overlapMap = new Map(overlapping.map((p) => [String(p.staffId), p]));

  const rows = staffDocs
    .map((staff) => {
      const sid = String(staff._id);
      const breakdown = [...byStaff.get(sid).values()].map((s) => ({ ...s, amount: siteAmount(staff, s) }));
      const otHours = breakdown.reduce((s, b) => s + b.otHours, 0);
      return {
        staff,
        breakdown,
        totalDays: breakdown.reduce((s, b) => s + b.presentDays + b.halfDays * 0.5, 0),
        otHours,
        otAmount: Math.round(otRateOf(staff) * otHours),
        totalAmount: breakdown.reduce((s, b) => s + b.amount, 0),
        advanceBalance: Math.max(0, balances.get(sid)?.balance || 0),
        overlap: overlapMap.get(sid) || null,
      };
    })
    .sort((a, b) => a.staff.name.localeCompare(b.staff.name));

  res.json({ periodStart: start, periodEnd: startOfDay(end), rows });
});

// Creates one payment per entry under a new payroll run. Entries that break a rule are skipped
// and reported; the run is only kept if at least one payment was created.
exports.createPayroll = asyncHandler(async (req, res) => {
  const { periodStart, periodEnd, entries, markPaid, paymentMode, paidDate, note } = req.body;
  const { start, end } = requireRange(periodStart, periodEnd);
  if (!Array.isArray(entries) || entries.length === 0) throw new HttpError(400, 'Select at least one staff member');
  if (markPaid) assertPaymentMode(paymentMode);
  entries.forEach((e) => requireId(e.staffId, 'staffId'));

  const staffDocs = await Staff.find(orgOrLegacy(req, { _id: { $in: entries.map((e) => e.staffId) } })).lean();
  const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));

  const run = await PayrollRun.create({
    periodStart: start,
    periodEnd: startOfDay(end),
    note,
    organizationId: req.organizationId,
  });

  const created = [];
  const skipped = [];
  for (const entry of entries) {
    const staff = staffMap.get(String(entry.staffId));
    if (!staff) {
      skipped.push({ staffId: entry.staffId, name: 'Unknown', reason: 'Staff not found' });
      continue;
    }
    try {
      created.push(
        await createPaymentFor({
          organizationId: req.organizationId,
          staff,
          start,
          end,
          bonus: toNumber(entry.bonus, 'Bonus'),
          deductions: toNumber(entry.deductions, 'Deductions'),
          advanceDeducted: toNumber(entry.advanceDeducted, 'Advance recovery'),
          note,
          markPaid,
          paymentMode,
          paidDate,
          payrollRunId: run._id,
        })
      );
    } catch (err) {
      if (!err.status) throw err;
      skipped.push({ staffId: entry.staffId, name: staff.name, reason: err.message });
    }
  }

  if (created.length === 0) {
    await run.deleteOne();
    throw new HttpError(400, `No payments were created. ${skipped.map((s) => `${s.name}: ${s.reason}`).join(' · ')}`);
  }

  res.status(201).json({
    run,
    created: created.length,
    totalNet: created.reduce((s, p) => s + p.netAmount, 0),
    skipped,
  });
});

exports.getPayrollRuns = asyncHandler(async (req, res) => {
  const runs = await PayrollRun.find({ organizationId: req.organizationId }).sort({ createdAt: -1 }).lean();
  const totals = await Payment.aggregate([
    { $match: { organizationId: toObjectId(req.organizationId), payrollRunId: { $in: runs.map((r) => r._id) } } },
    {
      $group: {
        _id: '$payrollRunId',
        count: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        totalNet: { $sum: { $ifNull: ['$netAmount', '$totalAmount'] } },
        totalGross: { $sum: '$totalAmount' },
      },
    },
  ]);
  const totalMap = new Map(totals.map((t) => [String(t._id), t]));
  res.json(
    runs
      .map((r) => ({ ...r, ...(totalMap.get(String(r._id)) || { count: 0, pending: 0, totalNet: 0, totalGross: 0 }) }))
      .filter((r) => r.count > 0)
  );
});

// Payroll sheet: the run, its payments and the business profile.
exports.getPayrollRun = asyncHandler(async (req, res) => {
  const [run, organization] = await Promise.all([
    PayrollRun.findOne({ _id: req.params.id, organizationId: req.organizationId }).lean(),
    Organization.findById(req.organizationId).lean(),
  ]);
  if (!run) throw new HttpError(404, 'Payroll run not found');
  const payments = await Payment.find({ payrollRunId: run._id, organizationId: req.organizationId })
    .populate('staffId', 'name role phone dailyWage')
    .populate('breakdown.siteId', 'name')
    .lean();
  payments.sort((a, b) => (a.staffId?.name || '').localeCompare(b.staffId?.name || ''));
  res.json({ run, payments, organization });
});

exports.markPayrollPaid = asyncHandler(async (req, res) => {
  const { paymentMode, paidDate } = req.body;
  assertPaymentMode(paymentMode);
  const run = await PayrollRun.findOne({ _id: req.params.id, organizationId: req.organizationId }).lean();
  if (!run) throw new HttpError(404, 'Payroll run not found');

  const result = await Payment.updateMany(
    { payrollRunId: run._id, organizationId: req.organizationId, status: 'pending' },
    { $set: { status: 'paid', paymentMode, paidDate: paidDate ? startOfDay(paidDate) : new Date() } }
  );
  res.json({ message: `${result.modifiedCount} payments marked paid`, updated: result.modifiedCount });
});

// A run can be cancelled only while none of its payments are paid.
exports.deletePayrollRun = asyncHandler(async (req, res) => {
  const run = await PayrollRun.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  const paid = await Payment.exists({ payrollRunId: run._id, status: 'paid' });
  if (paid) throw new HttpError(400, 'This payroll has paid payments and cannot be cancelled');
  await Payment.deleteMany({ payrollRunId: run._id, organizationId: req.organizationId });
  await run.deleteOne();
  res.json({ message: 'Payroll cancelled' });
});
