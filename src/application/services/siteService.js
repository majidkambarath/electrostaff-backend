const { pick, requireId } = require('../validation');
const { notFound, invalid } = require('../../domain/errors');
const { startOfDay, addDays, dayKey } = require('../../domain/dates');
const { siteAmount } = require('../../domain/wages');
const { financeSummary } = require('../../domain/finance');

const SITE_FIELDS = ['name', 'address', 'clientName', 'clientPhone', 'startDate', 'endDate', 'status', 'notes', 'contractValue'];

module.exports = ({ siteRepo, assignmentRepo, attendanceRepo, staffRepo, expenseRepo, receiptRepo, wageService }) => {
  const load = async (orgId, id) => {
    requireId(id, 'site id');
    const site = await siteRepo.findById(orgId, id);
    if (!site) throw notFound('Site');
    return site;
  };

  return {
    load,

    list: async (orgId) => {
      const today = startOfDay(new Date());
      const [sites, staffCounts, todayCounts, labour, received, expenses] = await Promise.all([
        siteRepo.list(orgId),
        assignmentRepo.activeCountBySite(orgId),
        attendanceRepo.todayCountsBySite(orgId, today),
        wageService.labourCostBySite(orgId),
        receiptRepo.sumBySite(orgId),
        expenseRepo.sumBySite(orgId),
      ]);
      return sites.map((site) => {
        const id = String(site._id);
        return {
          ...site,
          staffCount: staffCounts.get(id) || 0,
          markedToday: todayCounts.get(id)?.marked || 0,
          presentToday: todayCounts.get(id)?.present || 0,
          finance: financeSummary({
            contractValue: site.contractValue || 0,
            received: received.get(id) || 0,
            labourCost: labour.get(id)?.cost || 0,
            expenses: expenses.get(id) || 0,
          }),
        };
      });
    },

    get: async (orgId, id) => {
      const site = await load(orgId, id);
      return { ...site, staffCount: await assignmentRepo.countActiveForSite(orgId, site._id) };
    },

    create: (orgId, input) => siteRepo.create(orgId, pick(input, SITE_FIELDS)),

    update: async (orgId, id, input) => {
      requireId(id, 'site id');
      const body = pick(input, SITE_FIELDS);
      if (body.endDate === '') body.endDate = null;
      const site = await siteRepo.update(orgId, id, body);
      if (!site) throw notFound('Site');
      return site;
    },

    // Sites with attendance or money history are archived as completed rather than deleted.
    remove: async (orgId, id) => {
      const site = await load(orgId, id);
      const [hasAttendance, hasReceipts, hasExpenses] = await Promise.all([
        attendanceRepo.existsForSite(orgId, site._id),
        receiptRepo.existsForSite(orgId, site._id),
        expenseRepo.existsForSite(orgId, site._id),
      ]);
      if (hasAttendance || hasReceipts || hasExpenses) {
        const archived = await siteRepo.update(orgId, site._id, { status: 'completed' });
        await assignmentRepo.deactivateForSite(orgId, site._id);
        return { archived: true, message: 'Site has history, so it was marked completed', site: archived };
      }
      await assignmentRepo.removeForSite(orgId, site._id);
      await siteRepo.remove(orgId, site._id);
      return { archived: false, message: 'Site deleted' };
    },

    staff: (orgId, id) => assignmentRepo.listForSite(orgId, id),

    // Accepts { staffId } or { staffIds: [] }.
    assign: async (orgId, id, { staffId, staffIds }) => {
      const site = await load(orgId, id);
      if (site.status === 'completed') throw invalid('Reopen this site before assigning staff');
      const ids = (staffIds || [staffId]).filter(Boolean);
      if (ids.length === 0) throw invalid('Select at least one staff member');
      ids.forEach((sid) => requireId(sid, 'staffId'));

      const staff = await staffRepo.findManyInOrg(orgId, ids);
      if (staff.length !== ids.length) throw notFound('One or more staff members');
      if (staff.some((s) => s.status === 'inactive')) throw invalid('Inactive staff cannot be assigned. Reactivate them first.');

      await assignmentRepo.activate(orgId, site._id, ids);
      return assignmentRepo.listForSiteAndStaff(orgId, site._id, ids);
    },

    unassign: async (orgId, id, staffId) => {
      const assignment = await assignmentRepo.deactivate(orgId, id, staffId);
      if (!assignment) throw notFound('Assignment');
      return { message: 'Staff unassigned', assignment };
    },

    progress: async (orgId, id) => {
      const site = await load(orgId, id);
      const today = startOfDay(new Date());
      const trendStart = addDays(today, -13);
      const [assignments, records] = await Promise.all([
        assignmentRepo.listForSite(orgId, site._id, 'name phone role dailyWage otRate'),
        attendanceRepo.listForSite(orgId, site._id),
      ]);

      const staffMap = new Map(assignments.map((a) => [String(a.staffId._id), a.staffId]));
      // Wages of staff no longer assigned still count toward the site's labour cost.
      const missing = [...new Set(records.map((r) => String(r.staffId)))].filter((sid) => !staffMap.has(sid));
      if (missing.length) (await staffRepo.findByIds(orgId, missing, 'dailyWage otRate')).forEach((s) => staffMap.set(String(s._id), s));

      const emptyRow = () => ({ present: 0, absent: 0, half: 0, leave: 0, otHours: 0, totalMarked: 0 });
      const perStaff = new Map();
      const trend = new Map();
      for (let i = 0; i < 14; i++) {
        const d = addDays(trendStart, i);
        trend.set(dayKey(d), { date: dayKey(d), present: 0, half: 0, absent: 0, leave: 0 });
      }

      let markedToday = 0;
      for (const r of records) {
        const sid = String(r.staffId);
        if (!perStaff.has(sid)) perStaff.set(sid, emptyRow());
        const row = perStaff.get(sid);
        row[r.status] += 1;
        row.otHours += r.otHours || 0;
        row.totalMarked += 1;
        if (r.date.getTime() === today.getTime()) markedToday += 1;
        const t = trend.get(dayKey(r.date));
        if (t) t[r.status] += 1;
      }

      const earnedFor = (staff, row) =>
        siteAmount(staff || { dailyWage: 0 }, { presentDays: row.present, halfDays: row.half, otHours: row.otHours });

      let labourCost = 0;
      let personDays = 0;
      let otHours = 0;
      for (const [sid, row] of perStaff) {
        labourCost += earnedFor(staffMap.get(sid), row);
        personDays += row.present + row.half * 0.5;
        otHours += row.otHours;
      }

      const staffProgress = assignments.map((a) => {
        const row = perStaff.get(String(a.staffId._id)) || emptyRow();
        return { staff: a.staffId, ...row, payableDays: row.present + row.half * 0.5, earned: earnedFor(a.staffId, row) };
      });
      const totalStaff = assignments.length;

      return {
        site,
        summary: {
          totalStaff,
          markedToday,
          daysElapsed: Math.max(1, Math.round((today - startOfDay(site.startDate)) / 86400000) + 1),
          personDays,
          otHours,
          labourCost,
          attendanceTodayRate: totalStaff ? Math.round((markedToday / totalStaff) * 100) : 0,
        },
        staffProgress,
        trend: [...trend.values()],
      };
    },

    // Money view: contract, client receipts, expenses by category, labour cost and profit.
    finance: async (orgId, id) => {
      const site = await load(orgId, id);
      const [labour, receipts, expenses] = await Promise.all([
        wageService.labourCostBySite(orgId, { siteId: site._id }),
        receiptRepo.forSite(orgId, site._id),
        expenseRepo.forSite(orgId, site._id),
      ]);
      const byCategory = new Map();
      expenses.forEach((e) => byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount));
      const labourEntry = labour.get(String(site._id));
      return {
        site,
        summary: financeSummary({
          contractValue: site.contractValue || 0,
          received: receipts.reduce((s, r) => s + r.amount, 0),
          labourCost: labourEntry?.cost || 0,
          expenses: expenses.reduce((s, e) => s + e.amount, 0),
        }),
        personDays: labourEntry?.personDays || 0,
        costBreakdown: [
          { category: 'labour', amount: labourEntry?.cost || 0 },
          ...[...byCategory.entries()].map(([category, amount]) => ({ category, amount })),
        ].sort((a, b) => b.amount - a.amount),
        receipts,
        expenses,
      };
    },
  };
};
