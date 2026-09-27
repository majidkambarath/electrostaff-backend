const Staff = require('../models/Staff');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Payment = require('../models/Payment');
const Performance = require('../models/Performance');
const Site = require('../models/Site');
const SiteAssignment = require('../models/SiteAssignment');
const Expense = require('../models/Expense');
const ClientReceipt = require('../models/ClientReceipt');
const { orgOrLegacy } = require('../middleware/orgMiddleware');
const { asyncHandler } = require('../utils/http');
const { startOfDay, addDays, dayKey, monthKey } = require('../utils/date');
const { payableUnits, netAmountOf, otRateOf, computeOutstanding, advanceBalances } = require('../services/wages');
const { sumBySite } = require('../services/finance');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TREND_DAYS = 14;
const TREND_MONTHS = 6;

exports.getDashboard = asyncHandler(async (req, res) => {
  const org = req.organizationId;
  const now = new Date();
  const today = startOfDay(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const trendMonthsStart = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1), 1);
  const trendDaysStart = addDays(today, -(TREND_DAYS - 1));
  const rangeStart = trendMonthsStart < trendDaysStart ? trendMonthsStart : trendDaysStart;

  const [
    staff,
    sites,
    assignments,
    attendance,
    paidPayments,
    pendingPayments,
    pendingLeaves,
    performance,
    outstanding,
    advances,
    receivedBySite,
    monthExpenses,
    monthReceipts,
  ] = await Promise.all([
    Staff.find(orgOrLegacy(req)).select('name role status dailyWage otRate').lean(),
    Site.find({ organizationId: org }).select('name status clientName contractValue').lean(),
    SiteAssignment.find({ organizationId: org, active: true }).select('staffId siteId').lean(),
    Attendance.find({ organizationId: org, date: { $gte: rangeStart } }).select('staffId siteId date status otHours').lean(),
    Payment.find({ organizationId: org, status: 'paid', paidDate: { $gte: trendMonthsStart } })
      .select('totalAmount netAmount paidDate')
      .lean(),
    Payment.find({ organizationId: org, status: 'pending' })
      .populate('staffId', 'name role')
      .sort({ createdAt: -1 })
      .lean(),
    Leave.find(orgOrLegacy(req, { status: 'pending' }))
      .populate('staff', 'name role')
      .sort({ startDate: 1 })
      .lean(),
    Performance.find(orgOrLegacy(req, { month: now.getMonth() + 1, year: now.getFullYear() }))
      .populate('staff', 'name role')
      .sort({ rating: -1, tasksCompleted: -1 })
      .limit(5)
      .lean(),
    computeOutstanding(org),
    advanceBalances(org),
    sumBySite(ClientReceipt, org),
    Expense.find({ organizationId: org, date: { $gte: monthStart } }).select('siteId amount').lean(),
    ClientReceipt.find({ organizationId: org, date: { $gte: monthStart } }).select('amount').lean(),
  ]);

  const staffMap = new Map(staff.map((s) => [String(s._id), s]));
  // Day wages plus overtime for one attendance record, at the current rates.
  const earnedFor = (r) => {
    const s = staffMap.get(String(r.staffId));
    const units = payableUnits(r.status);
    return s && units ? s.dailyWage * units + otRateOf(s) * (r.otHours || 0) : 0;
  };
  const siteMap = new Map(sites.map((s) => [String(s._id), s]));
  const activeSiteIds = new Set(sites.filter((s) => s.status === 'active').map((s) => String(s._id)));

  // Daily attendance trend
  const dayBuckets = new Map();
  for (let i = 0; i < TREND_DAYS; i++) {
    const d = addDays(trendDaysStart, i);
    dayBuckets.set(dayKey(d), {
      date: dayKey(d),
      label: `${DAY_LABELS[d.getDay()]} ${d.getDate()}`,
      present: 0,
      half: 0,
      absent: 0,
      leave: 0,
    });
  }

  // Monthly earned (attendance x wage) vs paid (net payments by paid date)
  const monthBuckets = new Map();
  for (let i = 0; i < TREND_MONTHS; i++) {
    const d = new Date(trendMonthsStart.getFullYear(), trendMonthsStart.getMonth() + i, 1);
    monthBuckets.set(monthKey(d), {
      month: monthKey(d),
      label: `${MONTH_LABELS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
      earned: 0,
      paid: 0,
    });
  }

  const todayCounts = { present: 0, half: 0, absent: 0, leave: 0 };
  const siteToday = new Map();
  const siteCostMonth = new Map();
  let monthMarked = 0;
  let monthPayable = 0;

  for (const r of attendance) {
    const key = dayKey(r.date);
    const earned = earnedFor(r);

    const db = dayBuckets.get(key);
    if (db) db[r.status] += 1;
    const mb = monthBuckets.get(key.slice(0, 7));
    if (mb) mb.earned += earned;

    if (r.date >= monthStart) {
      monthMarked += 1;
      monthPayable += payableUnits(r.status);
      const sid = String(r.siteId);
      siteCostMonth.set(sid, (siteCostMonth.get(sid) || 0) + earned);
    }

    if (r.date.getTime() === today.getTime()) {
      todayCounts[r.status] += 1;
      const sid = String(r.siteId);
      const entry = siteToday.get(sid) || { marked: 0, present: 0 };
      entry.marked += 1;
      if (r.status === 'present' || r.status === 'half') entry.present += 1;
      siteToday.set(sid, entry);
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

  // This month's cost per site: labour (attendance) + expenses booked to the site.
  const siteExpenseMonth = new Map();
  for (const e of monthExpenses) {
    if (!e.siteId) continue;
    const sid = String(e.siteId);
    siteExpenseMonth.set(sid, (siteExpenseMonth.get(sid) || 0) + e.amount);
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

  const currentMonth = monthBuckets.get(monthKey(now));
  let advanceOutstanding = 0;
  advances.forEach((a) => {
    advanceOutstanding += Math.max(0, a.balance);
  });

  res.json({
    today: dayKey(today),
    stats: {
      totalStaff: staff.length,
      activeStaff: staff.filter((s) => s.status === 'active').length,
      activeSites: activeSiteIds.size,
      totalSites: sites.length,
      assignedToday: assignedStaffToday.size,
      markedToday: Object.values(todayCounts).reduce((a, b) => a + b, 0),
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
      clientDues,
      monthExpenses: monthExpenses.reduce((sum, e) => sum + e.amount, 0),
      monthReceived: monthReceipts.reduce((sum, r) => sum + r.amount, 0),
    },
    charts: {
      attendanceTrend: [...dayBuckets.values()],
      wagesTrend: [...monthBuckets.values()].map((m) => ({ ...m, earned: Math.round(m.earned) })),
      siteCost,
    },
    sitesToday,
    pendingPayments: pendingPayments.slice(0, 5),
    pendingLeaves: pendingLeaves.filter((l) => l.staff).slice(0, 5),
    outstanding: outstanding.slice(0, 5),
    topPerformers: performance.filter((p) => p.staff),
  });
});
