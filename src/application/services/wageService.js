const { buildBreakdown, siteAmount, emptyCounts, addRecord, netPayable } = require('../../domain/wages');
const { endOfDay, startOfDay, addDays, requireDay } = require('../../domain/dates');
const { invalid, conflict } = require('../../domain/errors');

const PAYMENT_MODES = ['cash', 'upi', 'bank'];

const assertPaymentMode = (mode) => {
  if (!PAYMENT_MODES.includes(mode)) throw invalid('Choose a payment mode: cash, UPI or bank');
};

// Wage queries shared by payments, payroll, sites, dashboard, reports and the staff app.
module.exports = ({ attendanceRepo, paymentRepo, advanceRepo, staffRepo }) => {
  const calcBreakdown = async (staff, start, end, orgId) =>
    buildBreakdown(staff, await attendanceRepo.payableForStaff(orgId, staff._id, start, end));

  const assertNoOverlap = async (orgId, staffId, start, end) => {
    const overlap = await paymentRepo.findOverlapping(orgId, staffId, start, end);
    if (overlap) {
      const hint = overlap.status === 'pending' ? ' Mark it paid or cancel it first.' : '';
      throw conflict(`This period overlaps an existing ${overlap.status} payment.${hint}`);
    }
  };

  // Map staffId -> { given, recovered, balance, lastDate }.
  const advanceBalances = async (orgId, staffId) => {
    const [given, recovered] = await Promise.all([
      advanceRepo.givenByStaff(orgId, staffId),
      paymentRepo.advanceRecoveredByStaff(orgId, staffId),
    ]);
    const map = new Map();
    for (const g of given) map.set(String(g._id), { given: g.total, recovered: 0, balance: g.total, lastDate: g.lastDate });
    for (const r of recovered) {
      const entry = map.get(String(r._id)) || { given: 0, recovered: 0, balance: 0 };
      entry.recovered = r.total;
      entry.balance = entry.given - r.total;
      map.set(String(r._id), entry);
    }
    return map;
  };

  const advanceBalanceFor = async (orgId, staffId) => (await advanceBalances(orgId, staffId)).get(String(staffId))?.balance || 0;

  // Validates and creates one payment (pending, or paid when markPaid). Shared by single
  // payments and payroll runs so both enforce the same rules.
  const createPayment = async ({ orgId, staff, start, end, bonus = 0, deductions = 0, advanceDeducted = 0, note, markPaid, paymentMode, paidDate, payrollRunId, transactionRef, proofId }) => {
    await assertNoOverlap(orgId, staff._id, start, end);
    const [calc, advanceBalance] = await Promise.all([calcBreakdown(staff, start, end, orgId), advanceBalanceFor(orgId, staff._id)]);
    if (calc.totalDays === 0) throw invalid('No present or half days in this period to pay for');
    const { net, error } = netPayable({ gross: calc.totalAmount, bonus, deductions, advanceDeducted, advanceBalance });
    if (error) throw invalid(error);
    if (markPaid) assertPaymentMode(paymentMode);

    return paymentRepo.create({
      staffId: staff._id,
      periodStart: start,
      periodEnd: startOfDay(end),
      breakdown: calc.breakdown.map(({ siteId, presentDays, halfDays, otHours, otAmount, amount }) => ({
        siteId,
        presentDays,
        halfDays,
        otHours,
        otAmount,
        amount,
      })),
      dailyWage: staff.dailyWage,
      otRate: calc.otRate,
      otHours: calc.otHours,
      otAmount: calc.otAmount,
      totalDays: calc.totalDays,
      totalAmount: calc.totalAmount,
      bonus,
      deductions,
      advanceDeducted,
      netAmount: net,
      status: markPaid ? 'paid' : 'pending',
      paymentMode: markPaid ? paymentMode : undefined,
      paidDate: markPaid ? (paidDate ? requireDay(paidDate, 'paidDate') : new Date()) : undefined,
      note,
      transactionRef,
      proofId,
      payrollRunId,
      organizationId: orgId,
    });
  };

  // Labour cost from attendance per site: Map siteId -> { cost, personDays, otHours, staff: Set }.
  const labourCostBySite = async (orgId, range = {}) => {
    const groups = await attendanceRepo.payableGroups(orgId, range);
    const staffMap = await staffRepo.mapByIds(orgId, [...new Set(groups.map((g) => String(g._id.staffId)))], 'dailyWage otRate');
    const result = new Map();
    for (const g of groups) {
      const sid = String(g._id.siteId);
      const staff = staffMap.get(String(g._id.staffId)) || { dailyWage: 0, otRate: 0 };
      const entry = result.get(sid) || { cost: 0, personDays: 0, otHours: 0, staff: new Set() };
      entry.cost += siteAmount(staff, g);
      entry.personDays += g.presentDays + g.halfDays * 0.5;
      entry.otHours += g.otHours;
      entry.staff.add(String(g._id.staffId));
      result.set(sid, entry);
    }
    return result;
  };

  // Present/half attendance not covered by any payment period (pending or paid), per staff.
  // suggestedPeriod stops before the next existing payment so it can be paid without overlap.
  const computeOutstanding = async (orgId, { staffId } = {}) => {
    const [records, payments] = await Promise.all([attendanceRepo.payableAll(orgId, staffId), paymentRepo.periods(orgId, staffId)]);

    const periodsByStaff = new Map();
    for (const p of payments) {
      const sid = String(p.staffId);
      if (!periodsByStaff.has(sid)) periodsByStaff.set(sid, []);
      periodsByStaff.get(sid).push({ start: p.periodStart, end: endOfDay(p.periodEnd) });
    }

    const byStaff = new Map();
    for (const r of records) {
      const sid = String(r.staffId);
      if ((periodsByStaff.get(sid) || []).some((p) => r.date >= p.start && r.date <= p.end)) continue;
      if (!byStaff.has(sid)) byStaff.set(sid, { from: r.date, to: r.date, sites: new Map() });
      const entry = byStaff.get(sid);
      entry.to = r.date;
      const site = entry.sites.get(String(r.siteId)) || emptyCounts();
      addRecord(site, r);
      entry.sites.set(String(r.siteId), site);
    }
    if (byStaff.size === 0) return [];

    const [staffMap, balances] = await Promise.all([
      staffRepo.mapByIds(orgId, [...byStaff.keys()], 'name role phone dailyWage otRate status'),
      advanceBalances(orgId, staffId),
    ]);

    const rows = [];
    for (const [sid, entry] of byStaff) {
      const staff = staffMap.get(sid);
      if (!staff) continue;
      const totals = emptyCounts();
      let amount = 0;
      for (const site of entry.sites.values()) {
        totals.presentDays += site.presentDays;
        totals.halfDays += site.halfDays;
        totals.otHours += site.otHours;
        amount += siteAmount(staff, site);
      }
      const nextPaymentStart = (periodsByStaff.get(sid) || [])
        .map((p) => p.start)
        .filter((d) => d > entry.from && d <= entry.to)
        .sort((a, b) => a - b)[0];

      rows.push({
        staff,
        ...totals,
        payableDays: totals.presentDays + totals.halfDays * 0.5,
        amount,
        from: entry.from,
        to: entry.to,
        suggestedPeriod: { start: entry.from, end: nextPaymentStart ? addDays(nextPaymentStart, -1) : entry.to },
        advanceBalance: balances.get(sid)?.balance || 0,
      });
    }
    return rows.sort((a, b) => b.amount - a.amount);
  };

  return {
    PAYMENT_MODES,
    assertPaymentMode,
    calcBreakdown,
    assertNoOverlap,
    advanceBalances,
    advanceBalanceFor,
    createPayment,
    labourCostBySite,
    computeOutstanding,
  };
};
