const { orgOrLegacy, toMap } = require('./helpers');
const { normalizePhone } = require('../../../domain/credentials');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withPhoneKey = (data) => (data.phone ? { ...data, phoneKey: normalizePhone(data.phone) } : data);

// Organizations, office users and staff.
module.exports = ({ Organization, User, Staff }) => ({
  orgRepo: {
    findById: (id) => Organization.findById(id).lean(),
    exists: async (id) => Boolean(await Organization.exists({ _id: id })),
    findBySlug: (slug) => Organization.findOne({ slug }).lean(),
    create: async (data) => (await Organization.create(data)).toObject(),
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
    setPassword: (id, passwordHash) =>
      User.findByIdAndUpdate(id, { passwordHash, $inc: { tokenVersion: 1 } }, { new: true }).lean(),
    touchLogin: (id) => User.updateOne({ _id: id }, { lastLoginAt: new Date() }),
    // New sign-in number; bumps tokenVersion so every session must sign in again.
    setPhone: (id, phone) =>
      User.findByIdAndUpdate(id, { phone, phoneKey: normalizePhone(phone), $inc: { tokenVersion: 1 } }, { new: true }).lean(),
  },

  staffRepo: {
    list: async (orgId, { status, role, q } = {}) => {
      const filter = orgOrLegacy(orgId);
      if (status) filter.status = status;
      if (role) filter.role = role;
      if (q) {
        const rx = new RegExp(escapeRegex(q.trim()), 'i');
        filter.$or = [{ name: rx }, { phone: rx }];
      }
      return Staff.find(filter).sort({ createdAt: -1 }).lean();
    },
    findById: (orgId, id) => Staff.findOne(orgOrLegacy(orgId, { _id: id })).lean(),
    findManyInOrg: (orgId, ids) => Staff.find(orgOrLegacy(orgId, { _id: { $in: ids } })).lean(),
    findByIds: (ids, fields = 'name role phone dailyWage otRate status') =>
      Staff.find({ _id: { $in: ids } }).select(fields).lean(),
    mapByIds: async (ids, fields) =>
      toMap(await Staff.find({ _id: { $in: ids } }).select(fields || 'name role phone dailyWage otRate status').lean()),
    listForOrg: (orgId, fields = 'name role status dailyWage otRate') => Staff.find(orgOrLegacy(orgId)).select(fields).lean(),
    listActive: (orgId, fields = '_id') => Staff.find(orgOrLegacy(orgId, { status: { $ne: 'inactive' } })).select(fields).lean(),
    phoneTaken: async (orgId, phone, excludeId) => {
      const filter = orgOrLegacy(orgId, { phone: phone.trim() });
      if (excludeId) filter._id = { $ne: excludeId };
      return Boolean(await Staff.exists(filter));
    },
    create: async (orgId, data) => (await Staff.create({ ...withPhoneKey(data), organizationId: orgId })).toObject(),
    // Saving a legacy record (no organizationId) claims it for the org.
    update: (orgId, id, set, unset = {}) =>
      Staff.findOneAndUpdate(
        orgOrLegacy(orgId, { _id: id }),
        { $set: { ...withPhoneKey(set), organizationId: orgId }, ...(Object.keys(unset).length && { $unset: unset }) },
        { new: true, runValidators: true }
      ).lean(),
    setStatus: (id, status) => Staff.updateOne({ _id: id }, { status }),
    remove: (id) => Staff.deleteOne({ _id: id }),

    // Staff app access
    findForLogin: (phoneKey) =>
      Staff.find({ phoneKey, portalEnabled: true, status: { $ne: 'inactive' } }).select('+passwordHash').lean(),
    findAuthById: (id) =>
      Staff.findById(id).select('name phone role organizationId portalEnabled status tokenVersion mustChangePassword').lean(),
    findByIdWithSecret: (id) => Staff.findById(id).select('+passwordHash').lean(),
    enablePortal: (orgId, id, passwordHash, phone) =>
      Staff.findOneAndUpdate(
        orgOrLegacy(orgId, { _id: id }),
        {
          $set: { portalEnabled: true, passwordHash, mustChangePassword: true, phoneKey: normalizePhone(phone), organizationId: orgId },
          $inc: { tokenVersion: 1 },
        },
        { new: true }
      ).lean(),
    disablePortal: (orgId, id) =>
      Staff.findOneAndUpdate(
        orgOrLegacy(orgId, { _id: id }),
        { $set: { portalEnabled: false }, $unset: { passwordHash: 1 }, $inc: { tokenVersion: 1 } },
        { new: true }
      ).lean(),
    setPassword: (id, passwordHash) =>
      Staff.findByIdAndUpdate(id, { passwordHash, mustChangePassword: false, $inc: { tokenVersion: 1 } }, { new: true }).lean(),
    touchLogin: (id) => Staff.updateOne({ _id: id }, { lastLoginAt: new Date() }),
  },
});
