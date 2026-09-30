const { requireRange, monthRange, dayKey } = require('../../domain/dates');
const { siteAmount, netAmountOf, otRateOf } = require('../../domain/wages');
const { invalid, notFound } = require('../../domain/errors');
const { requireId } = require('../validation');

const emptyCounts = () => ({ present: 0, half: 0, absent: 0, leave: 0, otHours: 0 });
const addCounts = (target, c) => Object.keys(c).forEach((k) => (target[k] += c[k]));

module.exports = ({ attendanceRepo, paymentRepo, advanceRepo, expenseRepo, receiptRepo, staffRepo, siteRepo, assignmentRepo }) => ({
  // Wage & money report for [from, to], grouped by staff and by site.
  summary: async (orgId, { from, to }) => {
    const { start, end } = requireRange(from, to, 'from', 'to');
    const range = { start, end };
    const [records, payments, advances, expensesBySite, receiptsBySite, generalExpenses] = await Promise.all([
      attendanceRepo.inRange(orgId, start, end),
      paymentRepo.paidInRange(orgId, start, end),
      advanceRepo.inRange(orgId, start, end),
      expenseRepo.sumBySite(orgId, range),
      receiptRepo.sumBySite(orgId, range),
      expenseRepo.generalTotal(orgId, start, end),
    ]);

    const staffIds = new Set([...records, ...payments, ...advances].map((r) => String(r.staffId)));
    const siteIds = new Set([...records.map((r) => String(r.siteId)), ...expensesBySite.keys(), ...receiptsBySite.keys()]);
    const [staffDocs, siteDocs] = await Promise.all([
      staffRepo.findByIds(orgId, [...staffIds], 'name role phone dailyWage otRate status'),
      siteRepo.findByIds(orgId, [...siteIds]),
    ]);
    const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));
    const siteMap = new Map(siteDocs.map((s) => [String(s._id), s]));

    // staff -> site -> counts, so amounts round per site exactly like payments do
    const matrix = new Map();
    for (const r of records) {
      const sid = String(r.staffId);
      if (!matrix.has(sid)) matrix.set(sid, new Map());
      const bySite = matrix.get(sid);
      if (!bySite.has(String(r.siteId))) bySite.set(String(r.siteId), emptyCounts());
      const c = bySite.get(String(r.siteId));
      c[r.status] += 1;
      if (r.status === 'present' || r.status === 'half') c.otHours += r.otHours || 0;
    }

    const staffRows = new Map();
    const siteRows = new Map();
    const staffRow = (sid) => {
      if (!staffRows.has(sid)) {
        staffRows.set(sid, { staff: staffMap.get(sid), ...emptyCounts(), payableDays: 0, otAmount: 0, earned: 0, paid: 0, advances: 0, advanceRecovered: 0 });
      }
      return staffRows.get(sid);
    };
    const siteRow = (site) => {
      if (!siteRows.has(site)) {
        siteRows.set(site, { site: siteMap.get(site) || { _id: site, name: 'Removed site' }, ...emptyCounts(), staff: new Set(), personDays: 0, labourCost: 0 });
      }
      return siteRows.get(site);
    };

    for (const [sid, bySite] of matrix) {
      const staff = staffMap.get(sid) || { dailyWage: 0 };
      const row = staffRow(sid);
      for (const [site, c] of bySite) {
        const amount = siteAmount(staff, { presentDays: c.present, halfDays: c.half, otHours: c.otHours });
        const days = c.present + c.half * 0.5;
        addCounts(row, c);
        row.payableDays += days;
        row.otAmount += Math.round(otRateOf(staff) * c.otHours);
        row.earned += amount;
        const sr = siteRow(site);
        addCounts(sr, c);
        sr.staff.add(sid);
        sr.personDays += days;
        sr.labourCost += amount;
      }
    }
    for (const p of payments) {
      const row = staffRow(String(p.staffId));
      row.paid += netAmountOf(p);
      row.advanceRecovered += p.advanceDeducted || 0;
    }
    for (const a of advances) staffRow(String(a.staffId)).advances += a.amount;
    for (const site of siteIds) siteRow(site);

    const byStaff = [...staffRows.values()].filter((r) => r.staff).sort((a, b) => b.earned - a.earned);
    const bySite = [...siteRows.entries()]
      .map(([id, { staff, ...rest }]) => {
        const expenses = expensesBySite.get(id) || 0;
        const received = receiptsBySite.get(id) || 0;
        return { ...rest, staffCount: staff.size, expenses, received, totalCost: rest.labourCost + expenses, net: received - rest.labourCost - expenses };
      })
      .sort((a, b) => b.totalCost - a.totalCost);

    const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
    const siteExpenses = sum(bySite, 'expenses');
    return {
      from: start,
      to: end,
      totals: {
        staffCount: byStaff.filter((r) => r.payableDays > 0).length,
        siteCount: bySite.length,
        payableDays: sum(byStaff, 'payableDays'),
        otHours: sum(byStaff, 'otHours'),
        earned: sum(byStaff, 'earned'),
        paid: sum(byStaff, 'paid'),
        advances: sum(byStaff, 'advances'),
        siteExpenses,
        generalExpenses,
        expenses: siteExpenses + generalExpenses,
        received: sum(bySite, 'received'),
      },
      byStaff,
      bySite,
    };
  },

  // Monthly attendance register (muster roll): one row per person, one cell per day.
  muster: async (orgId, { month, year, siteId }) => {
    const m = Number(month);
    const y = Number(year);
    if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) throw invalid('Valid month and year are required');
    if (siteId) requireId(siteId, 'siteId');
    const { start, end } = monthRange(y, m);

    const [records, site, people] = await Promise.all([
      attendanceRepo.forMuster(orgId, start, end, siteId),
      siteId ? siteRepo.findById(orgId, siteId) : null,
      siteId ? assignmentRepo.listForSite(orgId, siteId, '_id') : staffRepo.listActive(orgId),
    ]);
    if (siteId && !site) throw notFound('Site');

    const ids = new Set([...records.map((r) => String(r.staffId)), ...people.map((p) => String(p.staffId?._id || p._id))]);
    const staffDocs = await staffRepo.findByIds(orgId, [...ids], 'name role phone dailyWage');
    const rows = new Map(staffDocs.map((s) => [String(s._id), { staff: s, days: {}, totals: { ...emptyCounts(), payableDays: 0 } }]));
    for (const r of records) {
      const row = rows.get(String(r.staffId));
      if (!row) continue;
      const key = String(Number(dayKey(r.date).slice(8)));
      (row.days[key] ||= []).push({ status: r.status, otHours: r.otHours || 0, site: r.siteId?.name || '' });
      row.totals[r.status] += 1;
      if (r.status === 'present' || r.status === 'half') row.totals.otHours += r.otHours || 0;
    }
    rows.forEach((row) => {
      row.totals.payableDays = row.totals.present + row.totals.half * 0.5;
    });

    return {
      month: m,
      year: y,
      daysInMonth: new Date(y, m, 0).getDate(),
      site: site ? { _id: site._id, name: site.name, clientName: site.clientName } : null,
      rows: [...rows.values()].sort((a, b) => a.staff.name.localeCompare(b.staff.name)),
    };
  },
});
