const { pick } = require('../validation');
const { invalid, notFound } = require('../../domain/errors');

const ORG_FIELDS = ['name', 'ownerName', 'phone', 'email', 'address'];

module.exports = ({ orgRepo, config }) => {
  let cachedDefaultId = null;

  // The organization used by a single-business install (created on first use).
  const defaultOrgId = async () => {
    if (cachedDefaultId) return cachedDefaultId;
    if (config.defaultOrganizationId) {
      cachedDefaultId = config.defaultOrganizationId;
      return cachedDefaultId;
    }
    const org = (await orgRepo.findBySlug('default')) || (await orgRepo.create({ name: 'Default Organization', slug: 'default' }));
    cachedDefaultId = String(org._id);
    return cachedDefaultId;
  };

  const profile = (org) => ({ organizationId: String(org._id), ...pick(org, ORG_FIELDS) });

  return {
    defaultOrgId,
    get: async (orgId) => {
      const org = await orgRepo.findById(orgId);
      if (!org) throw notFound('Organization');
      return profile(org);
    },
    raw: (orgId) => orgRepo.findById(orgId),
    update: async (orgId, input) => {
      const body = pick(input, ORG_FIELDS);
      if (body.name !== undefined && !String(body.name).trim()) throw invalid('Business name is required');
      const org = await orgRepo.update(orgId, body);
      if (!org) throw notFound('Organization');
      return profile(org);
    },
  };
};
