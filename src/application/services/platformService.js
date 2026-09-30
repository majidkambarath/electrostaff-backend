const { requireId } = require('../validation');
const { invalid, notFound } = require('../../domain/errors');
const { generatePassword } = require('../../domain/credentials');
const { ORG_STATUSES } = require('../../domain/organizations');
const { PLANS, planStatus } = require('../../domain/plans');
const { requireDay } = require('../../domain/dates');

// The platform portal: operators of the SaaS see every business, create new ones and can
// suspend them. It never reads a business's wage records — only headline counts.
module.exports = ({ platformRepo, authService }) => {
  const row = ({ org, owner, counts }) => ({
    id: String(org._id),
    name: org.name,
    slug: org.slug,
    status: org.status || 'active',
    phone: org.phone,
    email: org.email,
    address: org.address,
    createdAt: org.createdAt,
    plan: planStatus(org.plan),
    owner: owner ? { name: owner.name, phone: owner.phone, lastLoginAt: owner.lastLoginAt || null } : null,
    counts,
  });

  const list = async () => (await platformRepo.overview()).map(row);

  return {
    list,

    overview: async () => {
      const orgs = await list();
      const sum = (key) => orgs.reduce((t, o) => t + o.counts[key], 0);
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      return {
        organizations: orgs.length,
        active: orgs.filter((o) => o.status === 'active').length,
        suspended: orgs.filter((o) => o.status === 'suspended').length,
        newLast30Days: orgs.filter((o) => new Date(o.createdAt).getTime() >= since).length,
        staff: sum('staff'),
        staffLogins: sum('staffLogins'),
        activeSites: sum('activeSites'),
        recent: orgs.slice(0, 5),
      };
    },

    get: async (id) => {
      requireId(id, 'organization id');
      const found = (await list()).find((o) => o.id === String(id));
      if (!found) throw notFound('Organization');
      return { ...found, users: await platformRepo.usersOf(id) };
    },

    // Creates a business and its owner. The owner's password is returned once so it can be shared.
    create: async (input = {}) => {
      const password = input.password || generatePassword();
      const { org, user } = await authService.createBusiness({
        businessName: input.businessName,
        name: input.ownerName,
        phone: input.phone,
        password,
        email: input.email,
        address: input.address,
      });
      return {
        organization: { id: String(org._id), name: org.name, slug: org.slug },
        owner: { name: user.name, phone: user.phone },
        password,
      };
    },

    // plan: { name, staffLimit?, validUntil? (YYYY-MM-DD) } or { name: null } to remove limits.
    setPlan: async (id, input = {}) => {
      requireId(id, 'organization id');
      let plan = null;
      if (input.name) {
        if (!PLANS[input.name]) throw invalid(`Plan must be one of ${Object.keys(PLANS).join(', ')}`);
        const limit = input.staffLimit === '' || input.staffLimit === undefined || input.staffLimit === null
          ? PLANS[input.name].staffLimit
          : Math.round(Number(input.staffLimit));
        if (limit !== null && !(Number.isFinite(limit) && limit >= 1 && limit <= 100000)) throw invalid('Staff limit must be a positive number');
        plan = { name: input.name, staffLimit: limit, validUntil: input.validUntil ? requireDay(input.validUntil, 'validUntil') : null };
        if (plan.validUntil) plan.validUntil.setHours(23, 59, 59, 999);
      }
      const org = await platformRepo.setOrgPlan(id, plan);
      if (!org) throw notFound('Organization');
      authService.forgetOrgStatus(id);
      return { id: String(org._id), plan: planStatus(org.plan) };
    },

    setStatus: async (id, status) => {
      requireId(id, 'organization id');
      if (!ORG_STATUSES.includes(status)) throw invalid(`Status must be one of ${ORG_STATUSES.join(', ')}`);
      const org = await platformRepo.setOrgStatus(id, status);
      if (!org) throw notFound('Organization');
      authService.forgetOrgStatus(id);
      return { id: String(org._id), status: org.status };
    },
  };
};
