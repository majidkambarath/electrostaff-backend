const { orgOrLegacy, oid, toMap } = require('./helpers');

const LEAVE_POPULATE = { path: 'staff', select: 'name phone role dailyWage' };

// Leaves, performance ratings and staff requests.
module.exports = ({ Leave, Performance, StaffRequest }) => ({
  leaveRepo: {
    list: async (orgId, { staffId, status } = {}) => {
      const filter = orgOrLegacy(orgId);
      if (staffId) filter.staff = staffId;
      if (status) filter.status = status;
      return (await Leave.find(filter).populate(LEAVE_POPULATE).sort({ createdAt: -1 }).lean()).filter((l) => l.staff);
    },
    findById: (orgId, id) => Leave.findOne(orgOrLegacy(orgId, { _id: id })).lean(),
    create: async (data) => (await (await Leave.create(data)).populate(LEAVE_POPULATE)).toObject(),
    update: (orgId, id, set) =>
      Leave.findOneAndUpdate(orgOrLegacy(orgId, { _id: id }), set, { new: true, runValidators: true }).populate(LEAVE_POPULATE).lean(),
    remove: (orgId, id) => Leave.findOneAndDelete(orgOrLegacy(orgId, { _id: id })).lean(),
    approvedTypesForDay: async (orgId, staffIds, dayStart, dayEnd) =>
      toMap(
        await Leave.find(
          orgOrLegacy(orgId, { staff: { $in: staffIds }, status: 'approved', startDate: { $lte: dayEnd }, endDate: { $gte: dayStart } })
        )
          .select('staff type')
          .lean(),
        'staff',
        (l) => l.type
      ),
    pending: async (orgId) =>
      (await Leave.find(orgOrLegacy(orgId, { status: 'pending' })).populate('staff', 'name role').sort({ startDate: 1 }).lean()).filter(
        (l) => l.staff
      ),
  },

  performanceRepo: {
    list: async (orgId, { staffId, month, year } = {}) => {
      const filter = orgOrLegacy(orgId);
      if (staffId) filter.staff = staffId;
      if (month) filter.month = month;
      if (year) filter.year = year;
      return (await Performance.find(filter).populate('staff', 'name phone role').sort({ year: -1, month: -1, rating: -1 }).lean()).filter(
        (r) => r.staff
      );
    },
    upsert: (staff, month, year, data) =>
      Performance.findOneAndUpdate({ staff, month, year }, { ...data, staff, month, year }, { new: true, upsert: true, runValidators: true })
        .populate('staff', 'name phone role')
        .lean(),
    remove: (orgId, id) => Performance.findOneAndDelete(orgOrLegacy(orgId, { _id: id })).lean(),
    top: async (orgId, month, year, limit = 5) =>
      (
        await Performance.find(orgOrLegacy(orgId, { month, year }))
          .populate('staff', 'name role')
          .sort({ rating: -1, tasksCompleted: -1 })
          .limit(limit)
          .lean()
      ).filter((p) => p.staff),
  },

  requestRepo: {
    list: async (orgId, { staffId, status } = {}) => {
      const filter = { organizationId: orgId };
      if (staffId) filter.staffId = staffId;
      if (status) filter.status = status;
      return (await StaffRequest.find(filter).populate('staffId', 'name role phone').sort({ createdAt: -1 }).lean()).filter(
        (r) => r.staffId
      );
    },
    findById: (orgId, id) => StaffRequest.findOne({ _id: id, organizationId: orgId }).populate('staffId', 'name role phone').lean(),
    create: async (data) => (await (await StaffRequest.create(data)).populate('staffId', 'name role phone')).toObject(),
    update: (orgId, id, set) =>
      StaffRequest.findOneAndUpdate({ _id: id, organizationId: orgId }, set, { new: true, runValidators: true })
        .populate('staffId', 'name role phone')
        .lean(),
    countPending: (orgId) => StaffRequest.countDocuments({ organizationId: oid(orgId), status: 'pending' }),
  },
});
