const { pick, requireId } = require('../validation');
const { requireRange, daysBetween, startOfDay } = require('../../domain/dates');
const { notFound, invalid } = require('../../domain/errors');

const LEAVE_FIELDS = ['staff', 'startDate', 'endDate', 'type', 'status', 'reason', 'responseNote'];
const TYPES = ['sick', 'casual', 'paid', 'unpaid', 'other'];
const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const span = (l) => (l.days > 1 ? `${shortDate(l.startDate)} – ${shortDate(l.endDate)} (${l.days} days)` : shortDate(l.startDate));

module.exports = ({ leaveRepo, staffRepo, notificationService }) => {
  const normalise = async (orgId, input) => {
    const data = pick(input, LEAVE_FIELDS);
    if (data.type !== undefined && !TYPES.includes(data.type)) throw invalid('Choose a valid leave type');
    if (data.staff !== undefined) {
      requireId(data.staff, 'staff');
      if (!(await staffRepo.findById(orgId, data.staff))) throw notFound('Staff');
    }
    if (data.startDate || data.endDate) {
      const { start, end } = requireRange(data.startDate, data.endDate, 'startDate', 'endDate');
      data.startDate = start;
      data.endDate = startOfDay(end);
      data.days = daysBetween(start, end);
    }
    return data;
  };

  return {
    list: (orgId, { staffId, status } = {}) =>
      leaveRepo.list(orgId, { staffId: staffId ? requireId(staffId, 'staffId') : undefined, status }),

    // source 'staff' = applied from the staff app (always pending; the office is notified).
    create: async (orgId, input, { source = 'admin', staffName } = {}) => {
      const data = await normalise(orgId, input);
      if (!data.staff) throw invalid('Staff is required');
      if (!data.startDate) throw invalid('Leave dates are required');
      if (source === 'staff') data.status = 'pending';
      const leave = await leaveRepo.create({ ...data, source, organizationId: orgId });
      if (source === 'staff') {
        notificationService.notifyAdmins(orgId, {
          type: 'leave',
          title: `${staffName || leave.staff?.name} applied for ${leave.type} leave`,
          body: `${span(leave)}${leave.reason ? ` · “${leave.reason}”` : ''}`,
          link: '/leaves',
        });
      }
      return leave;
    },

    update: async (orgId, id, input) => {
      requireId(id, 'leave id');
      const before = await leaveRepo.findById(orgId, id);
      if (!before) throw notFound('Leave');
      const data = await normalise(orgId, input);
      const decided = data.status && data.status !== before.status && ['approved', 'rejected'].includes(data.status);
      if (decided) data.decidedAt = new Date();
      const leave = await leaveRepo.update(orgId, id, { ...data, organizationId: orgId });
      if (decided) {
        notificationService.notifyStaff(orgId, leave.staff._id, {
          type: 'leave',
          title: `Your ${leave.type} leave was ${leave.status}`,
          body: span(leave) + (leave.responseNote ? ` · ${leave.responseNote}` : ''),
          link: '/me/leaves',
        });
      }
      return leave;
    },

    remove: async (orgId, id) => {
      requireId(id, 'leave id');
      const leave = await leaveRepo.remove(orgId, id);
      if (!leave) throw notFound('Leave');
      return { message: 'Leave deleted' };
    },

    // Staff app: a worker cancels their own pending application.
    cancelOwn: async (orgId, staffId, id) => {
      requireId(id, 'leave id');
      const leave = await leaveRepo.findById(orgId, id);
      if (!leave || String(leave.staff) !== String(staffId)) throw notFound('Leave');
      if (leave.status !== 'pending') throw invalid('Only pending leave can be cancelled');
      await leaveRepo.remove(orgId, id);
      return { message: 'Leave application cancelled' };
    },
  };
};
