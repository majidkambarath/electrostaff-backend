const Staff = require('../models/Staff');
const SiteAssignment = require('../models/SiteAssignment');
const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const Advance = require('../models/Advance');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { HttpError, asyncHandler, pick } = require('../utils/http');
const { advanceBalanceFor, toObjectId } = require('../services/wages');

const STAFF_FIELDS = ['name', 'email', 'phone', 'address', 'role', 'dailyWage', 'otRate', 'joinDate', 'status', 'notes'];

// An empty OT rate means 'use the default' (dailyWage / 8), so it is removed rather than stored.
const splitOtRate = (body) => {
  const clear = body.otRate === '' || body.otRate === null;
  if (clear) delete body.otRate;
  return clear;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertUniquePhone = async (req, phone, excludeId) => {
  if (!phone) return;
  const filter = orgOrLegacy(req, { phone: phone.trim() });
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Staff.exists(filter)) throw new HttpError(409, 'Another staff member already uses this phone number');
};

exports.getAllStaff = asyncHandler(async (req, res) => {
  const { status, role, q } = req.query;
  const filter = orgOrLegacy(req);
  if (status) filter.status = status;
  if (role) filter.role = role;
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { phone: rx }];
  }

  const staff = await Staff.find(filter).sort({ createdAt: -1 }).lean();

  const siteCounts = await SiteAssignment.aggregate([
    {
      $match: {
        organizationId: toObjectId(req.organizationId),
        active: true,
        staffId: { $in: staff.map((s) => s._id) },
      },
    },
    { $group: { _id: '$staffId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(siteCounts.map((c) => [String(c._id), c.count]));

  res.json(staff.map((s) => ({ ...s, siteCount: countMap.get(String(s._id)) || 0 })));
});

exports.getStaffById = asyncHandler(async (req, res) => {
  const staff = await Staff.findOne(orgOrLegacy(req, { _id: req.params.id })).lean();
  if (!staff) throw new HttpError(404, 'Staff not found');

  const [assignments, advanceBalance] = await Promise.all([
    SiteAssignment.find({ staffId: staff._id, active: true, organizationId: req.organizationId })
      .populate('siteId', 'name status clientName')
      .sort({ assignedDate: -1 })
      .lean(),
    advanceBalanceFor(req.organizationId, staff._id),
  ]);

  res.json({ ...staff, assignments, advanceBalance });
});

exports.createStaff = asyncHandler(async (req, res) => {
  const body = pick(req.body, STAFF_FIELDS);
  splitOtRate(body);
  await assertUniquePhone(req, body.phone);
  const staff = await Staff.create({ ...body, organizationId: req.organizationId });
  res.status(201).json(staff);
});

exports.updateStaff = asyncHandler(async (req, res) => {
  const body = pick(req.body, STAFF_FIELDS);
  const clearOt = splitOtRate(body);
  await assertUniquePhone(req, body.phone, req.params.id);
  // Saving a legacy record (no organizationId) claims it for the current org.
  const staff = await Staff.findOneAndUpdate(
    orgOrLegacy(req, { _id: req.params.id }),
    { $set: { ...body, organizationId: req.organizationId }, ...(clearOt && { $unset: { otRate: 1 } }) },
    { new: true, runValidators: true }
  );
  if (!staff) throw new HttpError(404, 'Staff not found');
  res.json(staff);
});

// Staff with attendance, payments or advances are archived (inactive) so wage history stays intact.
exports.deleteStaff = asyncHandler(async (req, res) => {
  const staff = await Staff.findOne(orgOrLegacy(req, { _id: req.params.id }));
  if (!staff) throw new HttpError(404, 'Staff not found');

  const [hasAttendance, hasPayments, hasAdvances] = await Promise.all([
    Attendance.exists({ staffId: staff._id }),
    Payment.exists({ staffId: staff._id }),
    Advance.exists({ staffId: staff._id }),
  ]);

  if (hasAttendance || hasPayments || hasAdvances) {
    staff.status = 'inactive';
    await staff.save();
    await SiteAssignment.updateMany({ staffId: staff._id }, { active: false });
    return res.json({ archived: true, message: 'Staff has work history, so they were marked inactive instead' });
  }

  await SiteAssignment.deleteMany({ staffId: staff._id });
  await staff.deleteOne();
  res.json({ archived: false, message: 'Staff removed' });
});
