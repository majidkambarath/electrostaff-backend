const { pick, requireId } = require('../validation');
const { monthRange } = require('../../domain/dates');
const { notFound, invalid } = require('../../domain/errors');

const FIELDS = ['rating', 'tasksCompleted', 'punctuality', 'quality', 'notes'];

module.exports = ({ performanceRepo, staffRepo, attendanceRepo }) => ({
  // Ratings for a month, plus each rated person's attendance for the same month.
  list: async (orgId, { staffId, month, year } = {}) => {
    const rated = await performanceRepo.list(orgId, {
      staffId: staffId ? requireId(staffId, 'staffId') : undefined,
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
    });
    if (!(month && year) || rated.length === 0) return rated;

    const { start, end } = monthRange(Number(year), Number(month));
    const stats = await attendanceRepo.monthStats(orgId, rated.map((r) => r.staff._id), start, end);
    return rated.map((r) => {
      const s = stats.get(String(r.staff._id));
      if (!s) return { ...r, attendance: null };
      const payableDays = s.present + s.half * 0.5;
      return { ...r, attendance: { marked: s.marked, payableDays, rate: Math.round((payableDays / s.marked) * 100) } };
    });
  },

  save: async (orgId, input) => {
    requireId(input.staff, 'staff');
    if (!input.month || !input.year) throw invalid('month and year are required');
    if (!(await staffRepo.findById(orgId, input.staff))) throw notFound('Staff');
    return performanceRepo.upsert(input.staff, Number(input.month), Number(input.year), {
      ...pick(input, FIELDS),
      organizationId: orgId,
    });
  },

  remove: async (orgId, id) => {
    requireId(id, 'record id');
    if (!(await performanceRepo.remove(orgId, id))) throw notFound('Record');
    return { message: 'Performance record deleted' };
  },
});
