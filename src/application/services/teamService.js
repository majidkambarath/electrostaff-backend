const { requireId, requireText } = require('../validation');
const { normalizePhone, generatePassword } = require('../../domain/credentials');
const { invalid, forbidden, notFound } = require('../../domain/errors');

const ROLES = ['admin', 'supervisor'];

// The office team of one business. Only the owner adds, changes or removes people.
//   admin      – everything the owner does, except managing the team
//   supervisor – sees and marks attendance only for their sites
// New people get a one-time password (returned once) and must set their own on first sign-in.
module.exports = ({ userRepo, siteRepo, authService, passwordHasher }) => {
  const assertOwner = (principal) => {
    if (principal.role !== 'owner') throw forbidden('Only the owner can manage the office team');
  };

  const cleanSites = async (orgId, role, siteIds) => {
    if (role !== 'supervisor') return [];
    const ids = [...new Set((Array.isArray(siteIds) ? siteIds : []).map((id) => requireId(id, 'siteId')))];
    if (!ids.length) throw invalid('Choose at least one site for the supervisor');
    const found = await siteRepo.findByIds(orgId, ids, '_id');
    if (found.length !== ids.length) throw invalid('One of the chosen sites was not found');
    return ids;
  };

  const view = ({ _id, name, phone, role, siteIds = [], lastLoginAt, createdAt, mustChangePassword }) => ({
    _id,
    name,
    phone,
    role,
    siteIds: siteIds.map(String),
    lastLoginAt: lastLoginAt || null,
    createdAt,
    invited: Boolean(mustChangePassword),
  });

  const load = async (orgId, id) => {
    requireId(id, 'user id');
    const user = await userRepo.findInOrg(orgId, id);
    if (!user) throw notFound('Team member');
    return user;
  };

  return {
    list: async (orgId) => (await userRepo.listForOrg(orgId)).map(view),

    create: async (orgId, principal, input = {}) => {
      assertOwner(principal);
      const name = requireText(input.name, 'Name', { min: 2 });
      const key = normalizePhone(input.phone);
      if (key.length !== 10) throw invalid('Enter a valid 10-digit mobile number');
      if (!ROLES.includes(input.role)) throw invalid('Choose admin or supervisor');
      const siteIds = await cleanSites(orgId, input.role, input.siteIds);
      await authService.assertLoginPhoneFree(key, {}, 'This number already signs in to ElectroStaff. Use a different number.');
      const password = generatePassword();
      const user = await userRepo.create({
        name,
        phone: key,
        role: input.role,
        siteIds,
        organizationId: orgId,
        passwordHash: await passwordHasher.hash(password),
        mustChangePassword: true,
      });
      return { member: view(user), password };
    },

    update: async (orgId, principal, id, input = {}) => {
      assertOwner(principal);
      const user = await load(orgId, id);
      if (user.role === 'owner') throw invalid('The owner cannot be changed here');
      const role = input.role === undefined ? user.role : input.role;
      if (!ROLES.includes(role)) throw invalid('Choose admin or supervisor');
      const set = {
        role,
        siteIds: await cleanSites(orgId, role, input.siteIds === undefined ? user.siteIds : input.siteIds),
      };
      if (input.name !== undefined) set.name = requireText(input.name, 'Name', { min: 2 });
      return view(await userRepo.updateInOrg(orgId, user._id, set)); // signs them out so the new access applies
    },

    resetPassword: async (orgId, principal, id) => {
      assertOwner(principal);
      const user = await load(orgId, id);
      if (user.role === 'owner') throw invalid('Change your own password from Settings');
      const password = generatePassword();
      await userRepo.setTempPassword(orgId, user._id, await passwordHasher.hash(password));
      return { member: view(user), password };
    },

    remove: async (orgId, principal, id) => {
      assertOwner(principal);
      const user = await load(orgId, id);
      if (user.role === 'owner') throw invalid('The owner cannot be removed');
      await userRepo.removeInOrg(orgId, user._id);
      return { message: `${user.name} can no longer sign in` };
    },
  };
};
