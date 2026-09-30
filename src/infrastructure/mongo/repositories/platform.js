const { toMap } = require('./helpers');

const countBy = async (Model, match = {}) =>
  toMap(await Model.aggregate([{ $match: match }, { $group: { _id: '$organizationId', n: { $sum: 1 } } }]), '_id', (r) => r.n);

// The platform portal: operators of the SaaS and cross-organization overviews.
// Nothing here is reachable by an office user or staff member.
module.exports = ({ PlatformAdmin, Organization, User, Staff, Site, Payment }) => ({
  platformAdminRepo: {
    count: () => PlatformAdmin.countDocuments(),
    findByUsernameWithSecret: (username) =>
      PlatformAdmin.findOne({ username: String(username).trim().toLowerCase() }).select('+passwordHash').lean(),
    findById: (id) => PlatformAdmin.findById(id).lean(),
    findByIdWithSecret: (id) => PlatformAdmin.findById(id).select('+passwordHash').lean(),
    create: async (data) => {
      const { passwordHash, ...rest } = (await PlatformAdmin.create(data)).toObject();
      return rest;
    },
    setPassword: (id, passwordHash) =>
      PlatformAdmin.findByIdAndUpdate(id, { passwordHash, $inc: { tokenVersion: 1 } }, { new: true }).lean(),
    touchLogin: (id) => PlatformAdmin.updateOne({ _id: id }, { lastLoginAt: new Date() }),
  },

  platformRepo: {
    // Every organization with its owner and headline counts, newest first.
    overview: async () => {
      const [orgs, owners, staff, logins, sites, paid] = await Promise.all([
        Organization.find().sort({ createdAt: -1 }).lean(),
        User.find({ role: 'owner' }).select('name phone organizationId lastLoginAt').lean(),
        countBy(Staff, { status: { $ne: 'inactive' } }),
        countBy(Staff, { portalEnabled: true }),
        countBy(Site, { status: { $ne: 'completed' } }),
        countBy(Payment, { status: 'paid' }),
      ]);
      const ownerOf = toMap(owners, 'organizationId');
      return orgs.map((o) => ({
        org: o,
        owner: ownerOf.get(String(o._id)) || null,
        counts: {
          staff: staff.get(String(o._id)) || 0,
          staffLogins: logins.get(String(o._id)) || 0,
          activeSites: sites.get(String(o._id)) || 0,
          paidPayments: paid.get(String(o._id)) || 0,
        },
      }));
    },
    usersOf: (orgId) => User.find({ organizationId: orgId }).select('name phone role lastLoginAt createdAt').sort({ createdAt: 1 }).lean(),
    setOrgStatus: (orgId, status) => Organization.findByIdAndUpdate(orgId, { status }, { new: true, runValidators: true }).lean(),
  },
});
