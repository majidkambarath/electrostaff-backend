const { inOrg, toMap } = require('./helpers');
const { normalizePhone } = require('../../../domain/credentials');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withPhoneKey = (data) => (data.phone ? { ...data, phoneKey: normalizePhone(data.phone) } : data);

// Organizations, office users and staff.
module.exports = ({ Organization, User, Staff }) => ({
  orgRepo: {
    findById: (id) => Organization.findById(id).lean(),
    exists: async (id) => Boolean(await Organization.exists({ _id: id })),
    findBySlug: (slug) => Organization.findOne({ slug }).lean(),
    slugTaken: async (slug) => Boolean(await Organization.exists({ slug })),
    create: async (data) => (await Organization.create(data)).toObject(),
    remove: (id) => Organization.deleteOne({ _id: id }),
    update: (id, set) => Organization.findByIdAndUpdate(id, set, { new: true, runValidators: true }).lean(),
  },

  userRepo: {
    count: () => User.countDocuments(),
    findByPhoneKeyWithSecret: (phoneKey) => User.findOne({ phoneKey }).select('+passwordHash').lean(),
    findById: (id) => User.findById(id).lean(),
    findByIdWithSecret: (id) => User.findById(id).select('+passwordHash').lean(),
    create: async (data) => {
      const user = await User.create(withPhoneKey(data));
      const { passwordHash, ...rest } = user.toObject();
      return rest;
    },
    // Own password change / CLI reset: clears the "must change" flag.
    setPassword: (id, passwordHash) =>
      User.findByIdAndUpdate(id, { passwordHash, mustChangePassword: false, $inc: { tokenVersion: 1 } }, { new: true }).lean(),
    touchLogin: (id) => User.updateOne({ _id: id }, { lastLoginAt: new Date() }),

    // Office team of one business
    listForOrg: (orgId) =>
      User.find({ organizationId: orgId }).select('name phone role siteIds lastLoginAt createdAt mustChangePassword').sort({ createdAt: 1 }).lean(),
    findInOrg: (orgId, id) => User.findOne({ _id: id, organizationId: orgId }).lean(),
    updateInOrg: (orgId, id, set) =>
      User.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: set, $inc: { tokenVersion: 1 } }, { new: true, runValidators: true }).lean(),
    // Password set by the owner: the person must choose their own on next sign-in.
    setTempPassword: (orgId, id, passwordHash) =>
      User.findOneAndUpdate(
        { _id: id, organizationId: orgId },
        { passwordHash, mustChangePassword: true, $inc: { tokenVersion: 1 } },
        { new: true }
      ).lean(),
    removeInOrg: (orgId, id) => User.deleteOne({ _id: id, organizationId: orgId }),
    // New sign-in number; bumps tokenVersion so every session must sign in again.
    setPhone: (id, phone) =>
      User.findByIdAndUpdate(id, { phone, phoneKey: normalizePhone(phone), $inc: { tokenVersion: 1 } }, { new: true }).lean(),
  },

  staffRepo: {
    list: async (orgId, { status, role, q } = {}) => {
      const filter = inOrg(orgId);
      if (status) filter.status = status;
      if (role) filter.role = role;
      if (q) {
        const rx = new RegExp(escapeRegex(q.trim()), 'i');
        filter.$or = [{ name: rx }, { phone: rx }];
      }
      return Staff.find(filter).sort({ createdAt: -1 }).lean();
    },
    findById: (orgId, id) => Staff.findOne(inOrg(orgId, { _id: id })).lean(),
    findManyInOrg: (orgId, ids) => Staff.find(inOrg(orgId, { _id: { $in: ids } })).lean(),
    findByIds: (orgId, ids, fields = 'name role phone dailyWage otRate status') =>
      Staff.find(inOrg(orgId, { _id: { $in: ids } })).select(fields).lean(),
    mapByIds: async (orgId, ids, fields) =>
      toMap(await Staff.find(inOrg(orgId, { _id: { $in: ids } })).select(fields || 'name role phone dailyWage otRate status').lean()),
    listForOrg: (orgId, fields = 'name role status dailyWage otRate') => Staff.find(inOrg(orgId)).select(fields).lean(),
    listActive: (orgId, fields = '_id') => Staff.find(inOrg(orgId, { status: { $ne: 'inactive' } })).select(fields).lean(),
    countActive: (orgId) => Staff.countDocuments(inOrg(orgId, { status: { $ne: 'inactive' } })),
    phoneTaken: async (orgId, phone, excludeId) => {
      const filter = inOrg(orgId, { phone: phone.trim() });
      if (excludeId) filter._id = { $ne: excludeId };
      return Boolean(await Staff.exists(filter));
    },
    create: async (orgId, data) => (await Staff.create({ ...withPhoneKey(data), organizationId: orgId })).toObject(),
    update: (orgId, id, set, unset = {}) =>
      Staff.findOneAndUpdate(
        inOrg(orgId, { _id: id }),
        { $set: withPhoneKey(set), ...(Object.keys(unset).length && { $unset: unset }) },
        { new: true, runValidators: true }
      ).lean(),
    setStatus: (orgId, id, status) => Staff.updateOne(inOrg(orgId, { _id: id }), { status }),
    remove: (orgId, id) => Staff.deleteOne(inOrg(orgId, { _id: id })),

    // Staff app access
    findForLogin: (phoneKey) =>
      Staff.find({ phoneKey, portalEnabled: true, status: { $ne: 'inactive' } }).select('+passwordHash').lean(),
    // Any staff login (in any organization) on this number, other than excludeId.
    loginTaken: async (phoneKey, excludeId) =>
      Boolean(await Staff.exists({ phoneKey, portalEnabled: true, ...(excludeId && { _id: { $ne: excludeId } }) })),
    findAuthById: (id) =>
      Staff.findById(id).select('name phone role organizationId portalEnabled status tokenVersion mustChangePassword').lean(),
    findByIdWithSecret: (id) => Staff.findById(id).select('+passwordHash').lean(),
    enablePortal: (orgId, id, passwordHash, phone) =>
      Staff.findOneAndUpdate(
        inOrg(orgId, { _id: id }),
        {
          $set: { portalEnabled: true, passwordHash, mustChangePassword: true, phoneKey: normalizePhone(phone) },
          $inc: { tokenVersion: 1 },
        },
        { new: true }
      ).lean(),
    disablePortal: (orgId, id) =>
      Staff.findOneAndUpdate(
        inOrg(orgId, { _id: id }),
        { $set: { portalEnabled: false }, $unset: { passwordHash: 1 }, $inc: { tokenVersion: 1 } },
        { new: true }
      ).lean(),
    setPassword: (id, passwordHash) =>
      Staff.findByIdAndUpdate(id, { passwordHash, mustChangePassword: false, $inc: { tokenVersion: 1 } }, { new: true }).lean(),
    touchLogin: (id) => Staff.updateOne({ _id: id }, { lastLoginAt: new Date() }),
  },
});
