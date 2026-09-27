const { toObjectId } = require('./wages');

// siteId -> total amount of a money model (ClientReceipt / Expense), optionally within [start, end].
const sumBySite = async (Model, organizationId, { siteId, start, end } = {}) => {
  const match = { organizationId: toObjectId(organizationId), siteId: siteId ? toObjectId(siteId) : { $ne: null } };
  if (start || end) match.date = { ...(start && { $gte: start }), ...(end && { $lte: end }) };
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: '$siteId', total: { $sum: '$amount' } } }]);
  return new Map(rows.map((r) => [String(r._id), r.total]));
};

// Profit uses the contract value when one is set, otherwise what the client has paid so far.
const financeSummary = ({ contractValue = 0, received = 0, labourCost = 0, expenses = 0 }) => {
  const totalCost = labourCost + expenses;
  const revenue = contractValue > 0 ? contractValue : received;
  const profit = revenue - totalCost;
  return {
    contractValue,
    received,
    due: Math.max(0, contractValue - received),
    labourCost,
    expenses,
    totalCost,
    profit,
    margin: revenue > 0 ? Math.round((profit / revenue) * 100) : null,
  };
};

module.exports = { sumBySite, financeSummary };
