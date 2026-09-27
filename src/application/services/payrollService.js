const { requireId, toNumber } = require('../validation');
const { requireRange, startOfDay } = require('../../domain/dates');
const { siteAmount, otRateOf } = require('../../domain/wages');
const { notFound, invalid } = require('../../domain/errors');

module.exports = ({ payrollRunRepo, paymentRepo, attendanceRepo, staffRepo, orgRepo, wageService, paymentService }) => ({
  // Everyone with payable attendance in [from, to]: wages per site, advance balance, and whether
  // an existing payment already overlaps the period (those can't be included).
  preview: async (orgId, { from, to }) => {
    const { start, end } = requireRange(from, to, 'from', 'to');
    const [records, overlapping, balances] = await Promise.all([
      attendanceRepo.payableInRange(orgId, start, end),
      paymentRepo.overlappingRange(orgId, start, end),
      wageService.advanceBalances(orgId),
    ]);

    const byStaff = new Map();
    for (const r of records) {
      const sid = String(r.staffId);
      if (!byStaff.has(sid)) byStaff.set(sid, new Map());
      const sites = byStaff.get(sid);
      const key = String(r.siteId?._id || r.siteId);
      const site = sites.get(key) || { siteId: key, siteName: r.siteId?.name || 'Removed site', presentDays: 0, halfDays: 0, otHours: 0 };
      if (r.status === 'present') site.presentDays += 1;
      else site.halfDays += 1;
      site.otHours += r.otHours || 0;
      sites.set(key, site);
    }

    const staffDocs = await staffRepo.findByIds([...byStaff.keys()], 'name role phone dailyWage otRate status');
    const overlapMap = new Map(overlapping.map((p) => [String(p.staffId), p]));
    const rows = staffDocs
      .map((staff) => {
        const sid = String(staff._id);
        const breakdown = [...byStaff.get(sid).values()].map((s) => ({ ...s, amount: siteAmount(staff, s) }));
        const otHours = breakdown.reduce((s, b) => s + b.otHours, 0);
        return {
          staff,
          breakdown,
          totalDays: breakdown.reduce((s, b) => s + b.presentDays + b.halfDays * 0.5, 0),
          otHours,
          otAmount: Math.round(otRateOf(staff) * otHours),
          totalAmount: breakdown.reduce((s, b) => s + b.amount, 0),
          advanceBalance: Math.max(0, balances.get(sid)?.balance || 0),
          overlap: overlapMap.get(sid) || null,
        };
      })
      .sort((a, b) => a.staff.name.localeCompare(b.staff.name));

    return { periodStart: start, periodEnd: startOfDay(end), rows };
  },

  // One payment per entry under a new run. Entries that break a rule are skipped and reported;
  // the run is only kept if at least one payment was created.
  create: async (orgId, { periodStart, periodEnd, entries, markPaid, paymentMode, paidDate, note }) => {
    const { start, end } = requireRange(periodStart, periodEnd);
    if (!Array.isArray(entries) || entries.length === 0) throw invalid('Select at least one staff member');
    if (markPaid) wageService.assertPaymentMode(paymentMode);
    entries.forEach((e) => requireId(e.staffId, 'staffId'));

    const staffDocs = await staffRepo.findManyInOrg(orgId, entries.map((e) => e.staffId));
    const staffMap = new Map(staffDocs.map((s) => [String(s._id), s]));
    const run = await payrollRunRepo.create({ periodStart: start, periodEnd: startOfDay(end), note, organizationId: orgId });

    const created = [];
    const skipped = [];
    for (const entry of entries) {
      const staff = staffMap.get(String(entry.staffId));
      if (!staff) {
        skipped.push({ staffId: entry.staffId, name: 'Unknown', reason: 'Staff not found' });
        continue;
      }
      try {
        created.push(
          await wageService.createPayment({
            orgId,
            staff,
            start,
            end,
            bonus: toNumber(entry.bonus, 'Bonus'),
            deductions: toNumber(entry.deductions, 'Deductions'),
            advanceDeducted: toNumber(entry.advanceDeducted, 'Advance recovery'),
            note,
            markPaid,
            paymentMode,
            paidDate,
            payrollRunId: run._id,
          })
        );
      } catch (err) {
        if (!err.code) throw err;
        skipped.push({ staffId: entry.staffId, name: staff.name, reason: err.message });
      }
    }

    if (created.length === 0) {
      await payrollRunRepo.remove(run._id);
      throw invalid(`No payments were created. ${skipped.map((s) => `${s.name}: ${s.reason}`).join(' · ')}`);
    }
    if (markPaid) created.forEach((p) => paymentService.notifyPaid(orgId, p));
    return { run, created: created.length, totalNet: created.reduce((s, p) => s + p.netAmount, 0), skipped };
  },

  list: async (orgId) => {
    const runs = await payrollRunRepo.list(orgId);
    const totals = await paymentRepo.runTotals(orgId, runs.map((r) => r._id));
    return runs
      .map((r) => ({ ...r, ...(totals.get(String(r._id)) || { count: 0, pending: 0, totalNet: 0, totalGross: 0 }) }))
      .filter((r) => r.count > 0);
  },

  get: async (orgId, id) => {
    requireId(id, 'payroll id');
    const [run, organization] = await Promise.all([payrollRunRepo.findById(orgId, id), orgRepo.findById(orgId)]);
    if (!run) throw notFound('Payroll run');
    const payments = await paymentRepo.byRun(orgId, run._id);
    payments.sort((a, b) => (a.staffId?.name || '').localeCompare(b.staffId?.name || ''));
    return { run, payments, organization };
  },

  markPaid: async (orgId, id, { paymentMode, paidDate }) => {
    wageService.assertPaymentMode(paymentMode);
    const run = await payrollRunRepo.findById(orgId, id);
    if (!run) throw notFound('Payroll run');
    const pending = await paymentRepo.pendingInRun(orgId, run._id);
    const result = await paymentRepo.markRunPaid(orgId, run._id, {
      status: 'paid',
      paymentMode,
      paidDate: paidDate ? startOfDay(paidDate) : new Date(),
    });
    pending.forEach((p) => paymentService.notifyPaid(orgId, { ...p, periodStart: run.periodStart, periodEnd: run.periodEnd }));
    return { message: `${result.modifiedCount} payments marked paid`, updated: result.modifiedCount };
  },

  // A run can be cancelled only while none of its payments are paid.
  cancel: async (orgId, id) => {
    const run = await payrollRunRepo.findById(orgId, id);
    if (!run) throw notFound('Payroll run');
    if (await paymentRepo.runHasPaid(run._id)) throw invalid('This payroll has paid payments and cannot be cancelled');
    await paymentRepo.removeRun(orgId, run._id);
    await payrollRunRepo.remove(run._id);
    return { message: 'Payroll cancelled' };
  },
});
