const Expense = require('../models/Expense');
const Site = require('../models/Site');
const { HttpError, asyncHandler, pick, requireId, toNumber } = require('../utils/http');
const { requireDay, requireRange } = require('../utils/date');

const FIELDS = ['siteId', 'category', 'description', 'vendor', 'paymentMode'];
const POPULATE = { path: 'siteId', select: 'name' };

const normalise = async (req, body, { partial = false } = {}) => {
  const data = pick(body, FIELDS);
  if (data.siteId === '' || data.siteId === 'general') data.siteId = null;
  if (data.siteId) {
    requireId(data.siteId, 'siteId');
    const site = await Site.exists({ _id: data.siteId, organizationId: req.organizationId });
    if (!site) throw new HttpError(404, 'Site not found');
  }
  if (!partial || body.amount !== undefined) data.amount = toNumber(body.amount, 'Amount', { min: 1 });
  if (!partial || body.date !== undefined) data.date = requireDay(body.date, 'date');
  return data;
};

// Filters: siteId (or 'general' for expenses without a site), category, from/to.
exports.getExpenses = asyncHandler(async (req, res) => {
  const { siteId, category, from, to } = req.query;
  const filter = { organizationId: req.organizationId };
  if (siteId === 'general') filter.siteId = null;
  else if (siteId) filter.siteId = requireId(siteId, 'siteId');
  if (category) filter.category = category;
  if (from && to) {
    const { start, end } = requireRange(from, to, 'from', 'to');
    filter.date = { $gte: start, $lte: end };
  }

  const expenses = await Expense.find(filter).populate(POPULATE).sort({ date: -1, createdAt: -1 }).lean();
  res.json(expenses);
});

exports.createExpense = asyncHandler(async (req, res) => {
  const data = await normalise(req, req.body);
  const expense = await Expense.create({ ...data, organizationId: req.organizationId });
  res.status(201).json(await expense.populate(POPULATE));
});

exports.updateExpense = asyncHandler(async (req, res) => {
  const data = await normalise(req, req.body, { partial: true });
  const expense = await Expense.findOneAndUpdate({ _id: req.params.id, organizationId: req.organizationId }, data, {
    new: true,
    runValidators: true,
  }).populate(POPULATE);
  if (!expense) throw new HttpError(404, 'Expense not found');
  res.json(expense);
});

exports.deleteExpense = asyncHandler(async (req, res) => {
  const expense = await Expense.findOneAndDelete({ _id: req.params.id, organizationId: req.organizationId });
  if (!expense) throw new HttpError(404, 'Expense not found');
  res.json({ message: 'Expense deleted' });
});
