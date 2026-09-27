const { pick, requireId } = require('../validation');
const { notFound, conflict, invalid } = require('../../domain/errors');
const { assertPassword, generatePassword, normalizePhone } = require('../../domain/credentials');
const { assertUpiId } = require('../../domain/files');

const STAFF_FIELDS = ['name', 'email', 'phone', 'address', 'role', 'dailyWage', 'otRate', 'upiId', 'joinDate', 'status', 'notes'];
// Fields never sent to the office UI.
const publicStaff = ({ passwordHash, tokenVersion, ...rest }) => rest;

module.exports = ({ staffRepo, assignmentRepo, attendanceRepo, paymentRepo, advanceRepo, wageService, passwordHasher }) => {
  const assertUniquePhone = async (orgId, phone, excludeId) => {
    if (phone && (await staffRepo.phoneTaken(orgId, phone, excludeId))) {
      throw conflict('Another staff member already uses this phone number');
    }
  };

  // An empty OT rate means "use the default" (dailyWage / 8), so it is removed rather than stored.
  const splitOtRate = (body) => {
    const clear = body.otRate === '' || body.otRate === null;
    if (clear) delete body.otRate;
    return clear;
  };

  const load = async (orgId, id) => {
    requireId(id, 'staff id');
    const staff = await staffRepo.findById(orgId, id);
    if (!staff) throw notFound('Staff');
    return staff;
  };

  return {
    list: async (orgId, filters) => {
      const staff = await staffRepo.list(orgId, filters);
      const counts = await assignmentRepo.activeCountByStaff(orgId, staff.map((s) => s._id));
      return staff.map((s) => ({ ...publicStaff(s), siteCount: counts.get(String(s._id)) || 0 }));
    },

    get: async (orgId, id) => {
      const staff = await load(orgId, id);
      const [assignments, advanceBalance] = await Promise.all([
        assignmentRepo.listForStaff(orgId, staff._id),
        wageService.advanceBalanceFor(orgId, staff._id),
      ]);
      return { ...publicStaff(staff), assignments, advanceBalance };
    },

    create: async (orgId, input) => {
      const body = pick(input, STAFF_FIELDS);
      splitOtRate(body);
      assertUpiId(body.upiId);
      await assertUniquePhone(orgId, body.phone);
      return publicStaff(await staffRepo.create(orgId, body));
    },

    update: async (orgId, id, input) => {
      requireId(id, 'staff id');
      const body = pick(input, STAFF_FIELDS);
      const clearOt = splitOtRate(body);
      assertUpiId(body.upiId);
      await assertUniquePhone(orgId, body.phone, id);
      const staff = await staffRepo.update(orgId, id, body, clearOt ? { otRate: 1 } : {});
      if (!staff) throw notFound('Staff');
      return publicStaff(staff);
    },

    // Staff with attendance, payments or advances are archived (inactive) so wage history stays intact.
    remove: async (orgId, id) => {
      const staff = await load(orgId, id);
      const [hasAttendance, hasPayments, hasAdvances] = await Promise.all([
        attendanceRepo.existsForStaff(staff._id),
        paymentRepo.existsForStaff(staff._id),
        advanceRepo.existsForStaff(staff._id),
      ]);
      if (hasAttendance || hasPayments || hasAdvances) {
        await staffRepo.setStatus(staff._id, 'inactive');
        await assignmentRepo.deactivateForStaff(staff._id);
        await staffRepo.disablePortal(orgId, staff._id);
        return { archived: true, message: 'Staff has work history, so they were marked inactive instead' };
      }
      await assignmentRepo.removeForStaff(staff._id);
      await staffRepo.remove(staff._id);
      return { archived: false, message: 'Staff removed' };
    },

    // Turns on the staff app for this worker with a password (given or generated). The plain
    // password is returned once so the office can send it; only its hash is stored.
    grantAccess: async (orgId, id, { password, generate } = {}) => {
      const staff = await load(orgId, id);
      if (staff.status === 'inactive') throw invalid('Reactivate this staff member before giving app access');
      if (normalizePhone(staff.phone).length !== 10) throw invalid('Add a valid 10-digit mobile number first — it is their login');
      const plain = generate || !password ? generatePassword() : password;
      assertPassword(plain);
      await staffRepo.enablePortal(orgId, staff._id, await passwordHasher.hash(plain), staff.phone);
      return { staffId: String(staff._id), name: staff.name, phone: staff.phone, password: plain };
    },

    revokeAccess: async (orgId, id) => {
      const staff = await load(orgId, id);
      await staffRepo.disablePortal(orgId, staff._id);
      return { message: `${staff.name} can no longer sign in to the staff app` };
    },
  };
};
