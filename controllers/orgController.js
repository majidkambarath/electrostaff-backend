const Organization = require('../models/Organization');
const { HttpError, asyncHandler, pick } = require('../utils/http');

const ORG_FIELDS = ['name', 'ownerName', 'phone', 'email', 'address'];

exports.getOrg = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.organizationId).lean();
  if (!org) throw new HttpError(404, 'Organization not found');
  res.json({ organizationId: String(org._id), ...pick(org, ORG_FIELDS) });
});

exports.updateOrg = asyncHandler(async (req, res) => {
  const body = pick(req.body, ORG_FIELDS);
  if (body.name !== undefined && !String(body.name).trim()) throw new HttpError(400, 'Business name is required');
  const org = await Organization.findByIdAndUpdate(req.organizationId, body, { new: true, runValidators: true }).lean();
  if (!org) throw new HttpError(404, 'Organization not found');
  res.json({ organizationId: String(org._id), ...pick(org, ORG_FIELDS) });
});
