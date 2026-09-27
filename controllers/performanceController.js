const Performance = require('../models/Performance');
const Staff = require('../models/Staff');
const Attendance = require('../models/Attendance');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, pick, requireId } = require('../utils/http');
const { monthRange } = require('../utils/date');
const { toObjectId } = require('../services/wages');

const FIELDS = ['rating', 'tasksCompleted', 'punctuality', 'quality', 'notes'];

// Ratings for a month, plus each rated staff member's attendance for the same month.
exports.getPerformance = asyncHandler(async (req, res) => {
  const { staffId, month, year } = req.query;
  const filter = orgOrLegacy(req);
  if (staffId) filter.staff = requireId(staffId, 'staffId');
  if (month) filter.month = Number(month);
  if (year) filter.year = Number(year);

  const records = await Performance.find(filter)
    .populate('staff', 'name phone role')
    .sort({ year: -1, month: -1, rating: -1 })
    .lean();
  const rated = records.filter((r) => r.staff);

  if (!(month && year) || rated.length === 0) return res.json(rated);

  const { start, end } = monthRange(Number(year), Number(month));
  const stats = await Attendance.aggregate([
    {
      $match: {
        organizationId: toObjectId(req.organizationId),
        staffId: { $in: rated.map((r) => r.staff._id) },
        date: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: '$staffId',
        marked: { $sum: 1 },
        present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        half: { $sum: { $cond: [{ $eq: ['$status', 'half'] }, 1, 0] } },
      },
    },
  ]);
  const statMap = new Map(stats.map((s) => [String(s._id), s]));

  res.json(
    rated.map((r) => {
      const s = statMap.get(String(r.staff._id));
      if (!s) return { ...r, attendance: null };
      const payableDays = s.present + s.half * 0.5;
      return {
        ...r,
        attendance: { marked: s.marked, payableDays, rate: Math.round((payableDays / s.marked) * 100) },
      };
    })
  );
});

exports.createOrUpdatePerformance = asyncHandler(async (req, res) => {
  const { staff, month, year } = req.body;
  requireId(staff, 'staff');
  if (!month || !year) throw new HttpError(400, 'month and year are required');
  const exists = await Staff.exists(orgOrLegacy(req, { _id: staff }));
  if (!exists) throw new HttpError(404, 'Staff not found');

  const record = await Performance.findOneAndUpdate(
    { staff, month: Number(month), year: Number(year) },
    {
      ...pick(req.body, FIELDS),
      staff,
      month: Number(month),
      year: Number(year),
      organizationId: req.organizationId,
    },
    { new: true, upsert: true, runValidators: true }
  ).populate('staff', 'name phone role');

  res.status(201).json(record);
});

exports.deletePerformance = asyncHandler(async (req, res) => {
  const record = await Performance.findOneAndDelete(orgOrLegacy(req, { _id: req.params.id }));
  if (!record) throw new HttpError(404, 'Record not found');
  res.json({ message: 'Performance record deleted' });
});
