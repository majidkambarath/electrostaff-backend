const { oid, toMap, dateRange } = require('./helpers');

const PAYMENT_POPULATE = [
  { path: 'staffId', select: 'name phone role dailyWage otRate address joinDate upiId' },
  { path: 'breakdown.siteId', select: 'name address clientName' },
];
const LIST_POPULATE = [
  { path: 'staffId', select: 'name phone role dailyWage upiId' },
  { path: 'breakdown.siteId', select: 'name' },
];

// siteId -> total amount (receipts / expenses booked to a site), optionally within a date range.
const sumBySite = async (Model, orgId, { siteId, start, end } = {}) => {
  const match = { organizationId: oid(orgId), siteId: siteId ? oid(siteId) : { $ne: null } };
  if (start || end) match.date = dateRange(start, end);
  return toMap(
    await Model.aggregate([{ $match: match }, { $group: { _id: '$siteId', total: { $sum: '$amount' } } }]),
    '_id',
    (r) => r.total
  );
};

module.exports = ({ Payment, PayrollRun, Advance, Expense, ClientReceipt }) => ({
  paymentRepo: {
    findOverlapping: (orgId, staffId, start, end) =>
      Payment.findOne({ staffId, organizationId: orgId, periodStart: { $lte: end }, periodEnd: { $gte: start } })
        .select('status periodStart periodEnd')
        .lean(),
    // Payments of these staff covering `day` (attendance is locked for them).
    coveringDay: async (orgId, staffIds, dayStart, dayEnd) =>
      toMap(
        await Payment.find({
          organizationId: orgId,
          staffId: { $in: staffIds },
          periodStart: { $lte: dayEnd },
          periodEnd: { $gte: dayStart },
        })
          .select('staffId status')
          .lean(),
        'staffId',
        (p) => p.status
      ),
    overlappingRange: (orgId, start, end) =>
      Payment.find({ organizationId: orgId, periodStart: { $lte: end }, periodEnd: { $gte: start } })
        .select('staffId status periodStart periodEnd')
        .lean(),
    periods: (orgId, staffId) => {
      const filter = { organizationId: orgId };
      if (staffId) filter.staffId = staffId;
      return Payment.find(filter).select('staffId periodStart periodEnd').lean();
    },
    create: async (data) => (await (await Payment.create(data)).populate(PAYMENT_POPULATE)).toObject(),
    findById: (orgId, id) => Payment.findOne({ _id: id, organizationId: orgId }).lean(),
    markPaid: (orgId, id, set) =>
      Payment.findOneAndUpdate({ _id: id, organizationId: orgId, status: 'pending' }, { $set: { ...set, status: 'paid' } }, { new: true })
        .populate(PAYMENT_POPULATE)
        .lean(),
    findDetailed: (orgId, id) => Payment.findOne({ _id: id, organizationId: orgId }).populate(PAYMENT_POPULATE).lean(),
    list: (orgId, { staffId, status, start, end } = {}) => {
      const filter = { organizationId: orgId };
      if (staffId) filter.staffId = staffId;
      if (status) filter.status = status;
      if (start && end) {
        filter.periodStart = { $lte: end };
        filter.periodEnd = { $gte: start };
      }
      return Payment.find(filter).populate(LIST_POPULATE).sort({ createdAt: -1 }).lean();
    },
    remove: (orgId, id) => Payment.deleteOne({ _id: id, organizationId: orgId }),
    existsForStaff: async (orgId, staffId) => Boolean(await Payment.exists({ staffId, organizationId: orgId })),
    advanceRecoveredByStaff: async (orgId, staffId) => {
      const match = { organizationId: oid(orgId), advanceDeducted: { $gt: 0 } };
      if (staffId) match.staffId = oid(staffId);
      return Payment.aggregate([{ $match: match }, { $group: { _id: '$staffId', total: { $sum: '$advanceDeducted' } } }]);
    },
    paidSince: (orgId, since) =>
      Payment.find({ organizationId: orgId, status: 'paid', paidDate: { $gte: since } }).select('totalAmount netAmount paidDate').lean(),
    pending: (orgId) =>
      Payment.find({ organizationId: orgId, status: 'pending' }).populate('staffId', 'name role').sort({ createdAt: -1 }).lean(),
    paidInRange: (orgId, start, end) =>
      Payment.find({ organizationId: orgId, status: 'paid', paidDate: { $gte: start, $lte: end } })
        .select('staffId totalAmount netAmount advanceDeducted')
        .lean(),
    byRun: (orgId, runId) =>
      Payment.find({ payrollRunId: runId, organizationId: orgId })
        .populate('staffId', 'name role phone dailyWage')
        .populate('breakdown.siteId', 'name')
        .lean(),
    runTotals: async (orgId, runIds) =>
      toMap(
        await Payment.aggregate([
          { $match: { organizationId: oid(orgId), payrollRunId: { $in: runIds } } },
          {
            $group: {
              _id: '$payrollRunId',
              count: { $sum: 1 },
              pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
              totalNet: { $sum: { $ifNull: ['$netAmount', '$totalAmount'] } },
              totalGross: { $sum: '$totalAmount' },
            },
          },
        ])
      ),
    pendingInRun: (orgId, runId) =>
      Payment.find({ payrollRunId: runId, organizationId: orgId, status: 'pending' }).select('staffId netAmount totalAmount').lean(),
    markRunPaid: (orgId, runId, set) =>
      Payment.updateMany({ payrollRunId: runId, organizationId: orgId, status: 'pending' }, { $set: set }),
    runHasPaid: async (orgId, runId) => Boolean(await Payment.exists({ payrollRunId: runId, organizationId: orgId, status: 'paid' })),
    removeRun: (orgId, runId) => Payment.deleteMany({ payrollRunId: runId, organizationId: orgId }),
    recentForStaff: (orgId, staffId, limit = 3) =>
      Payment.find({ organizationId: orgId, staffId }).sort({ createdAt: -1 }).limit(limit).lean(),
  },

  payrollRunRepo: {
    create: async (data) => (await PayrollRun.create(data)).toObject(),
    list: (orgId) => PayrollRun.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean(),
    findById: (orgId, id) => PayrollRun.findOne({ _id: id, organizationId: orgId }).lean(),
    remove: (orgId, id) => PayrollRun.deleteOne({ _id: id, organizationId: orgId }),
  },

  advanceRepo: {
    list: (orgId, staffId) => {
      const filter = { organizationId: orgId };
      if (staffId) filter.staffId = staffId;
      return Advance.find(filter).populate('staffId', 'name role phone').sort({ date: -1, createdAt: -1 }).lean();
    },
    givenByStaff: (orgId, staffId) => {
      const match = { organizationId: oid(orgId) };
      if (staffId) match.staffId = oid(staffId);
      return Advance.aggregate([
        { $match: match },
        { $group: { _id: '$staffId', total: { $sum: '$amount' }, lastDate: { $max: '$date' } } },
      ]);
    },
    create: async (data) => {
      const doc = await Advance.create(data);
      return (await doc.populate('staffId', 'name role phone')).toObject();
    },
    findById: (orgId, id) => Advance.findOne({ _id: id, organizationId: orgId }).lean(),
    remove: (orgId, id) => Advance.deleteOne({ _id: id, organizationId: orgId }),
    existsForStaff: async (orgId, staffId) => Boolean(await Advance.exists({ staffId, organizationId: orgId })),
    inRange: (orgId, start, end) => Advance.find({ organizationId: orgId, date: { $gte: start, $lte: end } }).select('staffId amount').lean(),
  },

  expenseRepo: {
    list: (orgId, { siteId, general, category, start, end } = {}) => {
      const filter = { organizationId: orgId };
      if (general) filter.siteId = null;
      else if (siteId) filter.siteId = siteId;
      if (category) filter.category = category;
      if (start && end) filter.date = { $gte: start, $lte: end };
      return Expense.find(filter).populate('siteId', 'name').sort({ date: -1, createdAt: -1 }).lean();
    },
    create: async (data) => (await (await Expense.create(data)).populate('siteId', 'name')).toObject(),
    update: (orgId, id, set) =>
      Expense.findOneAndUpdate({ _id: id, organizationId: orgId }, set, { new: true, runValidators: true })
        .populate('siteId', 'name')
        .lean(),
    remove: (orgId, id) => Expense.findOneAndDelete({ _id: id, organizationId: orgId }).lean(),
    sumBySite: (orgId, range) => sumBySite(Expense, orgId, range),
    forSite: (orgId, siteId) => Expense.find({ siteId, organizationId: orgId }).sort({ date: -1 }).lean(),
    since: (orgId, since) => Expense.find({ organizationId: orgId, date: { $gte: since } }).select('siteId amount').lean(),
    generalTotal: async (orgId, start, end) => {
      const rows = await Expense.aggregate([
        { $match: { organizationId: oid(orgId), siteId: null, date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      return rows[0]?.total || 0;
    },
    existsForSite: async (orgId, siteId) => Boolean(await Expense.exists({ siteId, organizationId: orgId })),
  },

  receiptRepo: {
    list: (orgId, { siteId, start, end } = {}) => {
      const filter = { organizationId: orgId };
      if (siteId) filter.siteId = siteId;
      if (start && end) filter.date = { $gte: start, $lte: end };
      return ClientReceipt.find(filter).populate('siteId', 'name clientName').sort({ date: -1, createdAt: -1 }).lean();
    },
    create: async (data) => (await (await ClientReceipt.create(data)).populate('siteId', 'name clientName')).toObject(),
    remove: (orgId, id) => ClientReceipt.findOneAndDelete({ _id: id, organizationId: orgId }).lean(),
    sumBySite: (orgId, range) => sumBySite(ClientReceipt, orgId, range),
    forSite: (orgId, siteId) => ClientReceipt.find({ siteId, organizationId: orgId }).sort({ date: -1 }).lean(),
    since: (orgId, since) => ClientReceipt.find({ organizationId: orgId, date: { $gte: since } }).select('amount').lean(),
    existsForSite: async (orgId, siteId) => Boolean(await ClientReceipt.exists({ siteId, organizationId: orgId })),
  },
});
