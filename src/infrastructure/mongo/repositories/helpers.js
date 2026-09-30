const mongoose = require('mongoose');

// Shared query helpers for the Mongo repositories.
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Every tenant query goes through this: documents of exactly one organization.
const inOrg = (organizationId, extra = {}) => ({ ...extra, organizationId });

const dateRange = (start, end) => ({ ...(start && { $gte: start }), ...(end && { $lte: end }) });

const toMap = (rows, key = '_id', value = (r) => r) => new Map(rows.map((r) => [String(r[key]), value(r)]));

module.exports = { oid, inOrg, dateRange, toMap };
