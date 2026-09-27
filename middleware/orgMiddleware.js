const mongoose = require('mongoose');
const Organization = require('../models/Organization');

let cachedDefaultOrgId = null;
const knownOrgIds = new Set();

const getDefaultOrgId = async () => {
  if (cachedDefaultOrgId) return cachedDefaultOrgId;
  if (process.env.DEFAULT_ORGANIZATION_ID) {
    cachedDefaultOrgId = process.env.DEFAULT_ORGANIZATION_ID;
    return cachedDefaultOrgId;
  }
  let org = await Organization.findOne({ slug: 'default' });
  if (!org) {
    org = await Organization.create({ name: 'Default Organization', slug: 'default' });
  }
  cachedDefaultOrgId = org._id.toString();
  knownOrgIds.add(cachedDefaultOrgId);
  return cachedDefaultOrgId;
};

const orgExists = async (id) => {
  if (!mongoose.isValidObjectId(id)) return false;
  if (knownOrgIds.has(id)) return true;
  const exists = await Organization.exists({ _id: id });
  if (exists) knownOrgIds.add(id);
  return Boolean(exists);
};

// Resolves req.organizationId from the x-organization-id header, falling back to the default org.
// An unknown header id is rejected so a stale browser value can't silently read an empty tenant;
// GET /api/org is exempt so the client can recover a valid id.
const attachOrg = async (req, res, next) => {
  try {
    const headerOrg = req.headers['x-organization-id'];
    if (headerOrg && (await orgExists(headerOrg))) {
      req.organizationId = headerOrg;
      return next();
    }
    if (headerOrg && req.path !== '/org') {
      return res.status(400).json({ message: 'Unknown organization. Reload the app to reset it.' });
    }
    req.organizationId = await getDefaultOrgId();
    next();
  } catch (error) {
    next(error);
  }
};

// Query filter scoped to the request's org. Also matches documents created before
// organizationId existed (null/missing), so legacy staff, leaves and ratings stay visible.
const orgOrLegacy = (req, extra = {}) => ({
  ...extra,
  organizationId: { $in: [req.organizationId, null] },
});

module.exports = { attachOrg, getDefaultOrgId, orgOrLegacy };
