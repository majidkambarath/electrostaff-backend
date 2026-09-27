const Advance = require('../models/Advance');
const Staff = require('../models/Staff');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, requireId, toNumber } = require('../utils/http');
const { requireDay } = require('../utils/date');
const { advanceBalances, advanceBalanceFor } = require('../services/wages');

exports.getAdvances = asyncHandler(async (req, res) => {
  const { staffId } = req.query;
  const filter = { organizationId: req.organizationId };
  if (staffId) filter.staffId = requireId(staffId, 'staffId');

  const advances = await Advance.find(filter)
    .populate('staffId', 'name role phone')
    .sort({ date: -1, createdAt: -1 })
    .lean();
  res.json(advances);
});

// Per-staff advance totals: given, recovered through payments, and outstanding balance.
exports.getBalances = asyncHandler(async (req, res) => {
  const balances = await advanceBalances(req.organizationId);
  const staff = await Staff.find({ _id: { $in: [...balances.keys()] } }).select('name role phone').lean();
  const rows = staff
    .map((s) => ({ staff: s, ...balances.get(String(s._id)) }))
    .sort((a, b) => b.balance - a.balance);
  res.json(rows);
});

exports.createAdvance = asyncHandler(async (req, res) => {
  const { staffId, date, paymentMode, note } = req.body;
  requireId(staffId, 'staffId');
  const amount = toNumber(req.body.amount, 'Amount', { min: 1 });
  const staff = await Staff.findOne(orgOrLegacy(req, { _id: staffId })).select('_id').lean();
  if (!staff) throw new HttpError(404, 'Staff not found');

  const advance = await Advance.create({
    staffId,
    amount,
    date: requireDay(date, 'date'),
    paymentMode,
    note,
    organizationId: req.organizationId,
  });
  res.status(201).json(await advance.populate('staffId', 'name role phone'));
});

// An advance can only be removed if the remaining advances still cover what payments already recovered.
exports.deleteAdvance = asyncHandler(async (req, res) => {
  const advance = await Advance.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!advance) throw new HttpError(404, 'Advance not found');

  const balance = await advanceBalanceFor(req.organizationId, advance.staffId);
  if (balance - advance.amount < 0) {
    throw new HttpError(400, 'Part of this advance was already recovered in a payment, so it cannot be deleted');
  }
  await advance.deleteOne();
  res.json({ message: 'Advance deleted' });
});
