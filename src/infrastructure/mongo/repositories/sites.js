const { oid, toMap } = require('./helpers');

const STAFF_FIELDS = 'name phone role dailyWage otRate status';

// Sites and site assignments (who works where).
module.exports = ({ Site, SiteAssignment }) => ({
  siteRepo: {
    list: (orgId) => Site.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean(),
    listForOrg: (orgId, fields = 'name status clientName contractValue') =>
      Site.find({ organizationId: orgId }).select(fields).lean(),
    findById: (orgId, id) => Site.findOne({ _id: id, organizationId: orgId }).lean(),
    exists: async (orgId, id) => Boolean(await Site.exists({ _id: id, organizationId: orgId })),
    findByIds: (ids, fields = 'name clientName status contractValue') => Site.find({ _id: { $in: ids } }).select(fields).lean(),
    create: async (orgId, data) => (await Site.create({ ...data, organizationId: orgId })).toObject(),
    update: (orgId, id, set) =>
      Site.findOneAndUpdate({ _id: id, organizationId: orgId }, set, { new: true, runValidators: true }).lean(),
    remove: (id) => Site.deleteOne({ _id: id }),
  },

  assignmentRepo: {
    activeCountBySite: async (orgId) =>
      toMap(
        await SiteAssignment.aggregate([
          { $match: { organizationId: oid(orgId), active: true } },
          { $group: { _id: '$siteId', count: { $sum: 1 } } },
        ]),
        '_id',
        (r) => r.count
      ),
    activeCountByStaff: async (orgId, staffIds) =>
      toMap(
        await SiteAssignment.aggregate([
          { $match: { organizationId: oid(orgId), active: true, staffId: { $in: staffIds.map(oid) } } },
          { $group: { _id: '$staffId', count: { $sum: 1 } } },
        ]),
        '_id',
        (r) => r.count
      ),
    countActiveForSite: (orgId, siteId) => SiteAssignment.countDocuments({ siteId, active: true, organizationId: orgId }),
    // Active assignments of a site with the staff member populated (missing staff filtered out).
    listForSite: async (orgId, siteId, staffFields = STAFF_FIELDS) =>
      (
        await SiteAssignment.find({ siteId, active: true, organizationId: orgId })
          .populate('staffId', staffFields)
          .sort({ assignedDate: -1 })
          .lean()
      ).filter((a) => a.staffId),
    listForStaff: async (orgId, staffId) =>
      (
        await SiteAssignment.find({ staffId, active: true, organizationId: orgId })
          .populate('siteId', 'name status clientName address')
          .sort({ assignedDate: -1 })
          .lean()
      ).filter((a) => a.siteId),
    listActive: (orgId) => SiteAssignment.find({ organizationId: orgId, active: true }).select('staffId siteId').lean(),
    assignedStaffIds: async (orgId, siteId, staffIds) =>
      new Set(
        (
          await SiteAssignment.find({ siteId, active: true, staffId: { $in: staffIds }, organizationId: orgId })
            .select('staffId')
            .lean()
        ).map((a) => String(a.staffId))
      ),
    isAssigned: async (orgId, siteId, staffId) =>
      Boolean(await SiteAssignment.exists({ siteId, staffId, active: true, organizationId: orgId })),
    activate: (orgId, siteId, staffIds) =>
      SiteAssignment.bulkWrite(
        staffIds.map((staffId) => ({
          updateOne: {
            filter: { staffId, siteId },
            update: { $set: { active: true, organizationId: orgId }, $setOnInsert: { assignedDate: new Date() } },
            upsert: true,
          },
        }))
      ),
    listForSiteAndStaff: (siteId, staffIds) =>
      SiteAssignment.find({ siteId, staffId: { $in: staffIds } }).populate('staffId', STAFF_FIELDS).lean(),
    deactivate: (orgId, siteId, staffId) =>
      SiteAssignment.findOneAndUpdate({ siteId, staffId, organizationId: orgId }, { active: false }, { new: true }).lean(),
    deactivateForStaff: (staffId) => SiteAssignment.updateMany({ staffId }, { active: false }),
    deactivateForSite: (siteId) => SiteAssignment.updateMany({ siteId }, { active: false }),
    removeForStaff: (staffId) => SiteAssignment.deleteMany({ staffId }),
    removeForSite: (orgId, siteId) => SiteAssignment.deleteMany({ siteId, organizationId: orgId }),
  },
});
