const Leave = require('../models/Leave');
const Staff = require('../models/Staff');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, pick, requireId } = require('../utils/http');
const { requireRange, daysBetween, startOfDay } = require('../utils/date');

const LEAVE_FIELDS = ['staff', 'startDate', 'endDate', 'type', 'status', 'reason'];
const POPULATE = { path: 'staff', select: 'name phone role dailyWage' };

const normalise = async (req, body) => {
  const data = pick(body, LEAVE_FIELDS);
  if (data.staff !== undefined) {
    requireId(data.staff, 'staff');
    const staff = await Staff.findOne(orgOrLegacy(req, { _id: data.staff })).select('_id').lean();
    if (!staff) throw new HttpError(404, 'Staff not found');
  }
  if (data.startDate || data.endDate) {
    const { start, end } = requireRange(data.startDate, data.endDate, 'startDate', 'endDate');
    data.startDate = start;
    data.endDate = startOfDay(end);
    data.days = daysBetween(start, end);
  }
  return data;
};

exports.getLeaves = asyncHandler(async (req, res) => {
  const { staffId, status } = req.query;
  const filter = orgOrLegacy(req);
  if (staffId) filter.staff = requireId(staffId, 'staffId');
  if (status) filter.status = status;

  const leaves = await Leave.find(filter).populate(POPULATE).sort({ createdAt: -1 }).lean();
  res.json(leaves.filter((l) => l.staff));
});

exports.createLeave = asyncHandler(async (req, res) => {
  const data = await normalise(req, req.body);
  if (!data.staff) throw new HttpError(400, 'Staff is required');
  if (!data.startDate) throw new HttpError(400, 'Leave dates are required');

  const leave = await Leave.create({ ...data, organizationId: req.organizationId });
  res.status(201).json(await leave.populate(POPULATE));
});

exports.updateLeave = asyncHandler(async (req, res) => {
  const data = await normalise(req, req.body);
  const leave = await Leave.findOneAndUpdate(
    orgOrLegacy(req, { _id: req.params.id }),
    { ...data, organizationId: req.organizationId },
    { new: true, runValidators: true }
  ).populate(POPULATE);
  if (!leave) throw new HttpError(404, 'Leave not found');
  res.json(leave);
});

exports.deleteLeave = asyncHandler(async (req, res) => {
  const leave = await Leave.findOneAndDelete(orgOrLegacy(req, { _id: req.params.id }));
  if (!leave) throw new HttpError(404, 'Leave not found');
  res.json({ message: 'Leave deleted' });
});
