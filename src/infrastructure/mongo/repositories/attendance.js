const { oid, toMap, dateRange } = require('./helpers');
const { PAYABLE_STATUSES } = require('../../../domain/wages');

// Attendance records. Payable = present / half.
module.exports = ({ Attendance }) => ({
  attendanceRepo: {
    forSiteDay: (orgId, siteId, day) => Attendance.find({ siteId, date: day, organizationId: orgId }).lean(),
    forStaffDay: (orgId, staffId, day) =>
      Attendance.find({ staffId, date: day, organizationId: orgId }).populate('siteId', 'name').lean(),

    // Payable records of these staff on `day` at other sites (site name populated).
    payableElsewhere: (orgId, staffIds, day, excludeSiteId) =>
      Attendance.find({
        organizationId: orgId,
        staffId: { $in: staffIds },
        date: day,
        siteId: { $ne: excludeSiteId },
        status: { $in: PAYABLE_STATUSES },
      })
        .populate('siteId', 'name')
        .lean(),

    // entries: [{ staffId, status (empty = clear), otHours, source, checkIn }]
    saveDay: (orgId, siteId, day, entries) =>
      Attendance.bulkWrite(
        entries.map(({ staffId, status, otHours, source = 'admin', checkIn }) => {
          const filter = { staffId, siteId, date: day, organizationId: orgId };
          if (!status) return { deleteOne: { filter } };
          const set = { status, otHours, source };
          if (checkIn) set.checkIn = checkIn;
          return {
            updateOne: {
              filter,
              update: { $set: set, ...(!checkIn && { $unset: { checkIn: 1 } }) },
              upsert: true,
            },
          };
        })
      ),

    listForStaff: (orgId, staffId, { siteId, start, end } = {}) => {
      const filter = { staffId, organizationId: orgId };
      if (siteId) filter.siteId = siteId;
      if (start || end) filter.date = dateRange(start, end);
      return Attendance.find(filter).populate('siteId', 'name address status').sort({ date: -1 }).lean();
    },
    existsForStaff: async (staffId) => Boolean(await Attendance.exists({ staffId })),
    existsForSite: async (orgId, siteId) => Boolean(await Attendance.exists({ siteId, organizationId: orgId })),

    // Payable records for wage calculation, flattened to { siteId, siteName, status, otHours }.
    payableForStaff: async (orgId, staffId, start, end) =>
      (
        await Attendance.find({
          staffId,
          organizationId: orgId,
          date: { $gte: start, $lte: end },
          status: { $in: PAYABLE_STATUSES },
        })
          .select('siteId status otHours')
          .populate('siteId', 'name')
          .lean()
      ).map((r) => ({
        siteId: r.siteId?._id || r.siteId,
        siteName: r.siteId?.name,
        status: r.status,
        otHours: r.otHours || 0,
      })),
    payableInRange: (orgId, start, end) =>
      Attendance.find({ organizationId: orgId, date: { $gte: start, $lte: end }, status: { $in: PAYABLE_STATUSES } })
        .select('staffId siteId status otHours')
        .populate('siteId', 'name')
        .lean(),
    payableAll: (orgId, staffId) => {
      const filter = { organizationId: orgId, status: { $in: PAYABLE_STATUSES } };
      if (staffId) filter.staffId = staffId;
      return Attendance.find(filter).select('staffId siteId date status otHours').sort({ date: 1 }).lean();
    },

    todayCountsBySite: async (orgId, day) =>
      toMap(
        await Attendance.aggregate([
          { $match: { organizationId: oid(orgId), date: day } },
          {
            $group: {
              _id: '$siteId',
              marked: { $sum: 1 },
              present: { $sum: { $cond: [{ $in: ['$status', PAYABLE_STATUSES] }, 1, 0] } },
            },
          },
        ])
      ),
    listForSite: (orgId, siteId) =>
      Attendance.find({ siteId, organizationId: orgId }).select('staffId date status otHours').lean(),
    since: (orgId, since) =>
      Attendance.find({ organizationId: orgId, date: { $gte: since } }).select('staffId siteId date status otHours source').lean(),
    inRange: (orgId, start, end) =>
      Attendance.find({ organizationId: orgId, date: { $gte: start, $lte: end } }).select('staffId siteId status otHours').lean(),
    forMuster: (orgId, start, end, siteId) => {
      const filter = { organizationId: orgId, date: { $gte: start, $lte: end } };
      if (siteId) filter.siteId = siteId;
      return Attendance.find(filter).populate('siteId', 'name').select('staffId siteId date status otHours').lean();
    },

    // Payable totals per (site, staff) — the input for labour cost.
    payableGroups: (orgId, { siteId, start, end } = {}) => {
      const match = { organizationId: oid(orgId), status: { $in: PAYABLE_STATUSES } };
      if (siteId) match.siteId = oid(siteId);
      if (start || end) match.date = dateRange(start, end);
      return Attendance.aggregate([
        { $match: match },
        {
          $group: {
            _id: { siteId: '$siteId', staffId: '$staffId' },
            presentDays: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            halfDays: { $sum: { $cond: [{ $eq: ['$status', 'half'] }, 1, 0] } },
            otHours: { $sum: { $ifNull: ['$otHours', 0] } },
          },
        },
      ]);
    },
    statusCounts: async (orgId, staffId, start, end) => {
      const rows = await Attendance.aggregate([
        { $match: { organizationId: oid(orgId), staffId: oid(staffId), date: { $gte: start, $lte: end } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      const counts = { present: 0, half: 0, absent: 0, leave: 0 };
      rows.forEach((r) => {
        counts[r._id] = r.count;
      });
      return counts;
    },
    monthStats: async (orgId, staffIds, start, end) =>
      toMap(
        await Attendance.aggregate([
          { $match: { organizationId: oid(orgId), staffId: { $in: staffIds.map(oid) }, date: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: '$staffId',
              marked: { $sum: 1 },
              present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
              half: { $sum: { $cond: [{ $eq: ['$status', 'half'] }, 1, 0] } },
            },
          },
        ])
      ),
  },
});
