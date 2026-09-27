const ClientReceipt = require('../models/ClientReceipt');
const Site = require('../models/Site');
const { HttpError, asyncHandler, pick, requireId, toNumber } = require('../utils/http');
const { requireDay, requireRange } = require('../utils/date');

const POPULATE = { path: 'siteId', select: 'name clientName' };

exports.getReceipts = asyncHandler(async (req, res) => {
  const { siteId, from, to } = req.query;
  const filter = { organizationId: req.organizationId };
  if (siteId) filter.siteId = requireId(siteId, 'siteId');
  if (from && to) {
    const { start, end } = requireRange(from, to, 'from', 'to');
    filter.date = { $gte: start, $lte: end };
  }
  const receipts = await ClientReceipt.find(filter).populate(POPULATE).sort({ date: -1, createdAt: -1 }).lean();
  res.json(receipts);
});

exports.createReceipt = asyncHandler(async (req, res) => {
  requireId(req.body.siteId, 'siteId');
  const site = await Site.exists({ _id: req.body.siteId, organizationId: req.organizationId });
  if (!site) throw new HttpError(404, 'Site not found');

  const receipt = await ClientReceipt.create({
    ...pick(req.body, ['siteId', 'paymentMode', 'reference', 'note']),
    amount: toNumber(req.body.amount, 'Amount', { min: 1 }),
    date: requireDay(req.body.date, 'date'),
    organizationId: req.organizationId,
  });
  res.status(201).json(await receipt.populate(POPULATE));
});

exports.deleteReceipt = asyncHandler(async (req, res) => {
  const receipt = await ClientReceipt.findOneAndDelete({ _id: req.params.id, organizationId: req.organizationId });
  if (!receipt) throw new HttpError(404, 'Receipt not found');
  res.json({ message: 'Client payment deleted' });
});
