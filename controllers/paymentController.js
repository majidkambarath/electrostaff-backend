const Payment = require('../models/Payment');
const Staff = require('../models/Staff');
const Attendance = require('../models/Attendance');
const Organization = require('../models/Organization');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, requireId, toNumber } = require('../utils/http');
const { requireRange, requireDay, startOfDay, endOfDay } = require('../utils/date');
const {
  calcBreakdown,
  findOverlappingPayment,
  advanceBalanceFor,
  assertPaymentMode,
  createPaymentFor,
  computeOutstanding,
  toObjectId,
} = require('../services/wages');

const POPULATE = [
  { path: 'staffId', select: 'name phone role dailyWage otRate address joinDate' },
  { path: 'breakdown.siteId', select: 'name address clientName' },
];

const loadStaff = async (req, staffId) => {
  requireId(staffId, 'staffId');
  const staff = await Staff.findOne(orgOrLegacy(req, { _id: staffId })).lean();
  if (!staff) throw new HttpError(404, 'Staff not found');
  return staff;
};

exports.previewPayment = asyncHandler(async (req, res) => {
  const { staffId, periodStart, periodEnd } = req.query;
  const staff = await loadStaff(req, staffId);
  const { start, end } = requireRange(periodStart, periodEnd);

  const overlap = await findOverlappingPayment(staff._id, start, end, req.organizationId);
  if (overlap) {
    const hint = overlap.status === 'pending' ? ' Mark it paid or cancel it first.' : '';
    throw new HttpError(409, `This period overlaps an existing ${overlap.status} payment.${hint}`);
  }

  const [calc, advanceBalance] = await Promise.all([
    calcBreakdown(staff, start, end, req.organizationId),
    advanceBalanceFor(req.organizationId, staff._id),
  ]);

  res.json({
    staff,
    ...calc,
    advanceBalance,
    periodStart: start,
    periodEnd: startOfDay(end),
  });
});

// Creates a pending payment, or a paid one in a single step when markPaid is true.
exports.createPayment = asyncHandler(async (req, res) => {
  const { staffId, periodStart, periodEnd, note, markPaid, paymentMode, paidDate } = req.body;
  const staff = await loadStaff(req, staffId);
  const { start, end } = requireRange(periodStart, periodEnd);

  const payment = await createPaymentFor({
    organizationId: req.organizationId,
    staff,
    start,
    end,
    bonus: toNumber(req.body.bonus, 'Bonus'),
    deductions: toNumber(req.body.deductions, 'Deductions'),
    advanceDeducted: toNumber(req.body.advanceDeducted, 'Advance recovery'),
    note,
    markPaid,
    paymentMode,
    paidDate,
  });

  res.status(201).json(await payment.populate(POPULATE));
});

exports.markPaid = asyncHandler(async (req, res) => {
  const { paymentMode, note, paidDate } = req.body;
  assertPaymentMode(paymentMode);

  const payment = await Payment.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (payment.status === 'paid') throw new HttpError(400, 'Payment is already marked as paid');

  payment.status = 'paid';
  payment.paymentMode = paymentMode;
  payment.paidDate = paidDate ? requireDay(paidDate, 'paidDate') : new Date();
  if (note) payment.note = note;
  await payment.save();

  res.json(await payment.populate(POPULATE));
});

// Only pending payments can be cancelled; this also releases their attendance days and advance recovery.
exports.deletePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (payment.status === 'paid') throw new HttpError(400, 'Paid payments cannot be cancelled');
  await payment.deleteOne();
  res.json({ message: 'Pending payment cancelled' });
});

exports.getPayments = asyncHandler(async (req, res) => {
  const { staffId, status, from, to } = req.query;
  const filter = { organizationId: req.organizationId };
  if (staffId) filter.staffId = requireId(staffId, 'staffId');
  if (status) filter.status = status;
  if (from && to) {
    const { start, end } = requireRange(from, to, 'from', 'to');
    filter.periodStart = { $lte: end };
    filter.periodEnd = { $gte: start };
  }

  const payments = await Payment.find(filter)
    .populate('staffId', 'name phone role dailyWage')
    .populate('breakdown.siteId', 'name')
    .sort({ createdAt: -1 })
    .lean();

  res.json(payments);
});

exports.getOutstanding = asyncHandler(async (req, res) => {
  const { staffId } = req.query;
  if (staffId) requireId(staffId, 'staffId');
  res.json(await computeOutstanding(req.organizationId, { staffId }));
});

// Slip data: the payment, the business profile and the staff member's attendance in the period.
exports.getPaymentById = asyncHandler(async (req, res) => {
  const [payment, organization] = await Promise.all([
    Payment.findOne({ _id: req.params.id, organizationId: req.organizationId }).populate(POPULATE).lean(),
    Organization.findById(req.organizationId).lean(),
  ]);
  if (!payment) throw new HttpError(404, 'Payment not found');

  const staffId = payment.staffId?._id || payment.staffId;
  const counts = await Attendance.aggregate([
    {
      $match: {
        organizationId: toObjectId(req.organizationId),
        staffId: toObjectId(staffId),
        date: { $gte: payment.periodStart, $lte: endOfDay(payment.periodEnd) },
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const attendance = { present: 0, half: 0, absent: 0, leave: 0 };
  counts.forEach((c) => {
    attendance[c._id] = c.count;
  });

  res.json({ ...payment, organization, attendance });
});
