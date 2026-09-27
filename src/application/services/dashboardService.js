const { startOfDay, addDays, dayKey, monthKey } = require('../../domain/dates');
const { payableUnits, netAmountOf, recordEarning } = require('../../domain/wages');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TREND_DAYS = 14;
const TREND_MONTHS = 6;

module.exports = (repos) => ({
  get: async (orgId) => {
    const { staffRepo, siteRepo, assignmentRepo, attendanceRepo, paymentRepo, leaveRepo, performanceRepo, receiptRepo, expenseRepo, requestRepo, wageService } = repos;
    const now = new Date();
    const today = startOfDay(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const trendMonthsStart = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1), 1);
    const trendDaysStart = addDays(today, -(TREND_DAYS - 1));
    const rangeStart = trendMonthsStart < trendDaysStart ? trendMonthsStart : trendDaysStart;

    const [staff, sites, assignments, attendance, paidPayments, pendingPayments, pendingLeaves, topPerformers, outstanding, advances, receivedBySite, monthExpenses, monthReceipts, pendingRequests] =
      await Promise.all([
        staffRepo.listForOrg(orgId),
        siteRepo.listForOrg(orgId),
        assignmentRepo.listActive(orgId),
        attendanceRepo.since(orgId, rangeStart),
        paymentRepo.paidSince(orgId, trendMonthsStart),
        paymentRepo.pending(orgId),
        leaveRepo.pending(orgId),
        performanceRepo.top(orgId, now.getMonth() + 1, now.getFullYear()),
        wageService.computeOutstanding(orgId),
        wageService.advanceBalances(orgId),
        receiptRepo.sumBySite(orgId),
        expenseRepo.since(orgId, monthStart),
        receiptRepo.since(orgId, monthStart),
        requestRepo.list(orgId, { status: 'pending' }),
      ]);

    const staffMap = new Map(staff.map((s) => [String(s._id), s]));
    const siteMap = new Map(sites.map((s) => [String(s._id), s]));
    const activeSiteIds = new Set(sites.filter((s) => s.status === 'active').map((s) => String(s._id)));

    const dayBuckets = new Map();
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = addDays(trendDaysStart, i);
      dayBuckets.set(dayKey(d), { date: dayKey(d), label: `${DAY_LABELS[d.getDay()]} ${d.getDate()}`, present: 0, half: 0, absent: 0, leave: 0 });
    }
    const monthBuckets = new Map();
    for (let i = 0; i < TREND_MONTHS; i++) {
      const d = new Date(trendMonthsStart.getFullYear(), trendMonthsStart.getMonth() + i, 1);
      monthBuckets.set(monthKey(d), { month: monthKey(d), label: `${MONTH_LABELS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, earned: 0, paid: 0 });
    }

    const todayCounts = { present: 0, half: 0, absent: 0, leave: 0 };
    const siteToday = new Map();
    const siteCostMonth = new Map();
    let monthMarked = 0;
    let monthPayable = 0;
    let selfMarkedToday = 0;

    for (const r of attendance) {
      const key = dayKey(r.date);
      const earned = recordEarning(staffMap.get(String(r.staffId)), r);
      const db = dayBuckets.get(key);
      if (db) db[r.status] += 1;
      const mb = monthBuckets.get(key.slice(0, 7));
      if (mb) mb.earned += earned;
      if (r.date >= monthStart) {
        monthMarked += 1;
        monthPayable += payableUnits(r.status);
        siteCostMonth.set(String(r.siteId), (siteCostMonth.get(String(r.siteId)) || 0) + earned);
      }
      if (r.date.getTime() === today.getTime()) {
        todayCounts[r.status] += 1;
        if (r.source === 'staff') selfMarkedToday += 1;
        const entry = siteToday.get(String(r.siteId)) || { marked: 0, present: 0 };
        entry.marked += 1;
        if (payableUnits(r.status)) entry.present += 1;
        siteToday.set(String(r.siteId), entry);
      }
    }
    for (const p of paidPayments) {
      const mb = monthBuckets.get(monthKey(p.paidDate));
      if (mb) mb.paid += netAmountOf(p);
    }

    const assignedBySite = new Map();
    const assignedStaffToday = new Set();
    for (const a of assignments) {
      const sid = String(a.siteId);
      if (!activeSiteIds.has(sid)) continue;
      assignedBySite.set(sid, (assignedBySite.get(sid) || 0) + 1);
      assignedStaffToday.add(String(a.staffId));
    }

    const sitesToday = [...activeSiteIds]
      .map((sid) => ({
        _id: sid,
        name: siteMap.get(sid).name,
        clientName: siteMap.get(sid).clientName,
        assigned: assignedBySite.get(sid) || 0,
        marked: siteToday.get(sid)?.marked || 0,
        present: siteToday.get(sid)?.present || 0,
      }))
      .sort((a, b) => a.marked / (a.assigned || 1) - b.marked / (b.assigned || 1) || b.assigned - a.assigned);

    const siteExpenseMonth = new Map();
    for (const e of monthExpenses) {
      if (e.siteId) siteExpenseMonth.set(String(e.siteId), (siteExpenseMonth.get(String(e.siteId)) || 0) + e.amount);
    }
    const siteCost = [...new Set([...siteCostMonth.keys(), ...siteExpenseMonth.keys()])]
      .map((sid) => {
        const labour = Math.round(siteCostMonth.get(sid) || 0);
        const expenses = siteExpenseMonth.get(sid) || 0;
        return { name: siteMap.get(sid)?.name || 'Removed site', labour, expenses, total: labour + expenses };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    let clientDues = 0;
    for (const site of sites) {
      if (site.contractValue > 0) clientDues += Math.max(0, site.contractValue - (receivedBySite.get(String(site._id)) || 0));
    }
    let advanceOutstanding = 0;
    advances.forEach((a) => {
      advanceOutstanding += Math.max(0, a.balance);
    });
    const currentMonth = monthBuckets.get(monthKey(now));

    return {
      today: dayKey(today),
      stats: {
        totalStaff: staff.length,
        activeStaff: staff.filter((s) => s.status === 'active').length,
        activeSites: activeSiteIds.size,
        totalSites: sites.length,
        assignedToday: assignedStaffToday.size,
        markedToday: Object.values(todayCounts).reduce((a, b) => a + b, 0),
        selfMarkedToday,
        presentToday: todayCounts.present,
        halfToday: todayCounts.half,
        absentToday: todayCounts.absent,
        leaveToday: todayCounts.leave,
        attendanceRate: monthMarked ? Math.round((monthPayable / monthMarked) * 100) : 0,
        monthEarned: Math.round(currentMonth?.earned || 0),
        monthPaid: Math.round(currentMonth?.paid || 0),
        pendingPaymentsCount: pendingPayments.length,
        pendingPaymentsAmount: pendingPayments.reduce((s, p) => s + netAmountOf(p), 0),
        outstandingAmount: outstanding.reduce((s, o) => s + o.amount, 0),
        outstandingStaff: outstanding.length,
        advanceOutstanding,
        pendingLeaves: pendingLeaves.length,
        pendingRequests: pendingRequests.length,
        clientDues,
        monthExpenses: monthExpenses.reduce((s, e) => s + e.amount, 0),
        monthReceived: monthReceipts.reduce((s, r) => s + r.amount, 0),
      },
      charts: {
        attendanceTrend: [...dayBuckets.values()],
        wagesTrend: [...monthBuckets.values()].map((m) => ({ ...m, earned: Math.round(m.earned) })),
        siteCost,
      },
      sitesToday,
      pendingPayments: pendingPayments.slice(0, 5),
      pendingLeaves: pendingLeaves.slice(0, 5),
      pendingRequests: pendingRequests.slice(0, 5),
      outstanding: outstanding.slice(0, 5),
      topPerformers,
    };
  },
});
