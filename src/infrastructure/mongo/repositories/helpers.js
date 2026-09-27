const mongoose = require('mongoose');

// Shared query helpers for the Mongo repositories.
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Scoped to one org; also matches documents created before organizationId existed.
const orgOrLegacy = (organizationId, extra = {}) => ({
  ...extra,
  organizationId: { $in: [organizationId, null] },
});

const dateRange = (start, end) => ({ ...(start && { $gte: start }), ...(end && { $lte: end }) });

const toMap = (rows, key = '_id', value = (r) => r) => new Map(rows.map((r) => [String(r[key]), value(r)]));

module.exports = { oid, orgOrLegacy, dateRange, toMap };
