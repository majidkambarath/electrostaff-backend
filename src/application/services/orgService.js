const { randomBytes } = require('crypto');
const { pick, requireText } = require('../validation');
const { invalid, notFound } = require('../../domain/errors');
const { slugify } = require('../../domain/organizations');

const ORG_FIELDS = ['name', 'ownerName', 'phone', 'email', 'address'];

// Organizations are the tenants: every business record belongs to exactly one.
module.exports = ({ orgRepo }) => {
  const profile = (org) => ({ organizationId: String(org._id), ...pick(org, ORG_FIELDS) });

  // A readable slug, suffixed with random characters when the plain one is taken.
  const uniqueSlug = async (name) => {
    const base = slugify(name);
    if (!(await orgRepo.slugTaken(base))) return base;
    for (let i = 0; i < 5; i += 1) {
      const slug = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await orgRepo.slugTaken(slug))) return slug;
    }
    throw invalid('Could not create the business, please try again');
  };

  return {
    get: async (orgId) => {
      const org = await orgRepo.findById(orgId);
      if (!org) throw notFound('Organization');
      return profile(org);
    },
    raw: (orgId) => orgRepo.findById(orgId),
    create: async (input) => {
      const body = pick(input, ORG_FIELDS);
      body.name = requireText(body.name, 'Business name', { min: 2 });
      return orgRepo.create({ ...body, slug: await uniqueSlug(body.name) });
    },
    remove: (orgId) => orgRepo.remove(orgId),
    update: async (orgId, input) => {
      const body = pick(input, ORG_FIELDS);
      if (body.name !== undefined && !String(body.name).trim()) throw invalid('Business name is required');
      const org = await orgRepo.update(orgId, body);
      if (!org) throw notFound('Organization');
      return profile(org);
    },
  };
};
