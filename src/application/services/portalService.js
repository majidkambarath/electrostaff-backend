const { requireId } = require('../validation');
const { invalid, notFound, conflict } = require('../../domain/errors');
const { startOfDay, endOfDay, dayKey } = require('../../domain/dates');
const { otRateOf, netAmountOf } = require('../../domain/wages');
const { summarize } = require('../../domain/attendance');

const STATUS_LABEL = { present: 'Present', half: 'Half day' };
const clockTime = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

const validLocation = ({ lat, lng, accuracy }) => {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln, accuracy: Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : undefined };
};

// Self-service for a signed-in worker. Every call is scoped to principal.staffId.
module.exports = ({ staffRepo, assignmentRepo, attendanceRepo, paymentRepo, advanceRepo, leaveRepo, requestRepo, wageService, attendanceService, paymentService, leaveService, requestService, notificationService }) => {
  const activeSitesFor = async (orgId, staffId) =>
    (await assignmentRepo.listForStaff(orgId, staffId))
      .filter((a) => a.siteId.status === 'active')
      .map((a) => ({ _id: a.siteId._id, name: a.siteId.name, clientName: a.siteId.clientName, address: a.siteId.address }));

  const todayRecords = async (orgId, staffId) =>
    (await attendanceRepo.forStaffDay(orgId, staffId, startOfDay(new Date()))).map((r) => ({
      _id: r._id,
      site: r.siteId ? { _id: r.siteId._id, name: r.siteId.name } : null,
      status: r.status,
      otHours: r.otHours || 0,
      source: r.source || 'admin',
      checkIn: r.checkIn?.at ? r.checkIn : null,
    }));

  return {
    home: async ({ organizationId: orgId, staffId }) => {
      const staff = await staffRepo.findById(orgId, staffId);
      if (!staff) throw notFound('Staff');
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [sites, today, monthRecords, monthWages, outstanding, advanceBalance, pendingLeaves, pendingRequests, recent] = await Promise.all([
        activeSitesFor(orgId, staffId),
        todayRecords(orgId, staffId),
        attendanceRepo.listForStaff(orgId, staffId, { start: monthStart, end: endOfDay(now) }),
        wageService.calcBreakdown(staff, monthStart, endOfDay(now), orgId),
        wageService.computeOutstanding(orgId, { staffId }),
        wageService.advanceBalanceFor(orgId, staffId),
        leaveRepo.list(orgId, { staffId, status: 'pending' }),
        requestRepo.list(orgId, { staffId, status: 'pending' }),
        paymentRepo.recentForStaff(orgId, staffId, 3),
      ]);
      const unpaid = outstanding[0];
      return {
        staff: {
          _id: staff._id,
          name: staff.name,
          role: staff.role,
          phone: staff.phone,
          dailyWage: staff.dailyWage,
          otRate: otRateOf(staff),
          joinDate: staff.joinDate,
        },
        date: dayKey(now),
        sites,
        today,
        month: { ...summarize(monthRecords), earned: monthWages.totalAmount },
        unpaid: unpaid ? { amount: unpaid.amount, payableDays: unpaid.payableDays, from: unpaid.from, to: unpaid.to } : null,
        advanceBalance: Math.max(0, advanceBalance),
        pendingLeaves: pendingLeaves.length,
        pendingRequests: pendingRequests.length,
        recentPayments: recent.map((p) => ({
          _id: p._id,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          totalDays: p.totalDays,
          netAmount: netAmountOf(p),
          status: p.status,
          paidDate: p.paidDate,
        })),
      };
    },

    // Worker marks themselves at one of their active sites for today, optionally with GPS.
    checkIn: async (principal, { siteId, status = 'present', lat, lng, accuracy }) => {
      const { organizationId: orgId, staffId, name } = principal;
      requireId(siteId, 'siteId');
      if (!STATUS_LABEL[status]) throw invalid('Choose present or half day');
      const site = (await activeSitesFor(orgId, staffId)).find((s) => String(s._id) === String(siteId));
      if (!site) throw invalid('You are not assigned to this site. Ask the office to add you.');

      const existing = (await todayRecords(orgId, staffId)).find((r) => String(r.site?._id) === String(siteId));
      if (existing && existing.source === 'admin') {
        throw conflict(`The office already marked you ${existing.status} at ${site.name} today`);
      }

      const at = new Date();
      const location = lat !== undefined && lng !== undefined ? validLocation({ lat, lng, accuracy }) : null;
      const result = await attendanceService.save(
        orgId,
        siteId,
        dayKey(at),
        [{ staffId, status, otHours: 0, checkIn: { at, ...(location || {}) } }],
        { source: 'staff' }
      );
      if (result.skipped.length) throw invalid(result.skipped[0].reason);

      notificationService.notifyAdmins(orgId, {
        type: 'attendance',
        title: `${name} checked in at ${site.name}`,
        body: `${STATUS_LABEL[status]} · ${clockTime(at)}${location ? ' · location shared' : ''}`,
        link: `/attendance?site=${siteId}`,
      });
      return { message: `Marked ${STATUS_LABEL[status].toLowerCase()} at ${site.name}`, today: await todayRecords(orgId, staffId) };
    },

    // Undo a self check-in made today (not possible once the office has marked or paid the day).
    undoCheckIn: async ({ organizationId: orgId, staffId }, { siteId }) => {
      requireId(siteId, 'siteId');
      const existing = (await todayRecords(orgId, staffId)).find((r) => String(r.site?._id) === String(siteId));
      if (!existing || existing.source !== 'staff') throw invalid('There is no check-in of yours to undo here');
      const result = await attendanceService.save(orgId, siteId, dayKey(new Date()), [{ staffId, status: '' }], { source: 'staff' });
      if (result.skipped.length) throw invalid(result.skipped[0].reason);
      return { message: 'Check-in removed', today: await todayRecords(orgId, staffId) };
    },

    attendance: ({ organizationId, staffId }, { month, year }) =>
      attendanceService.staffHistory(organizationId, staffId, { month, year }),

    payslips: ({ organizationId, staffId }) => paymentRepo.list(organizationId, { staffId }),
    payslip: ({ organizationId, staffId }, id) => paymentService.slip(organizationId, id, { ownerStaffId: staffId }),

    advances: async ({ organizationId, staffId }) => ({
      balance: Math.max(0, await wageService.advanceBalanceFor(organizationId, staffId)),
      items: await advanceRepo.list(organizationId, staffId),
    }),

    leaves: ({ organizationId, staffId }) => leaveService.list(organizationId, { staffId }),
    applyLeave: (principal, input) =>
      leaveService.create(
        principal.organizationId,
        { staff: principal.staffId, startDate: input.startDate, endDate: input.endDate, type: input.type, reason: input.reason },
        { source: 'staff', staffName: principal.name }
      ),
    cancelLeave: ({ organizationId, staffId }, id) => leaveService.cancelOwn(organizationId, staffId, id),

    requests: ({ organizationId, staffId }) => requestService.list(organizationId, { staffId }),
    createRequest: (principal, input) => requestService.create(principal.organizationId, principal, input),
    cancelRequest: ({ organizationId, staffId }, id) => requestService.cancelOwn(organizationId, staffId, id),
  };
};
