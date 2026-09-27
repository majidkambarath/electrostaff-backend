const { requireId, toNumber } = require('../validation');
const { requireRange, requireDay, startOfDay, endOfDay } = require('../../domain/dates');
const { notFound, invalid, forbidden } = require('../../domain/errors');
const { netAmountOf } = require('../../domain/wages');
const { parseImageDataUrl } = require('../../domain/files');

const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

module.exports = ({ paymentRepo, staffRepo, orgRepo, attendanceRepo, attachmentRepo, wageService, notificationService }) => {
  // Optional proof of payment: a UTR / reference and a screenshot (validated image).
  const proofFields = async (orgId, { transactionRef, proof }) => {
    const out = {};
    const ref = String(transactionRef || '').trim();
    if (ref) {
      if (ref.length > 64) throw invalid('Transaction reference is too long');
      out.transactionRef = ref;
    }
    if (proof) {
      const { contentType, data } = parseImageDataUrl(proof);
      out.proofId = (await attachmentRepo.create({ organizationId: orgId, kind: 'payment-proof', contentType, data }))._id;
    }
    return out;
  };

  const loadStaff = async (orgId, staffId) => {
    requireId(staffId, 'staffId');
    const staff = await staffRepo.findById(orgId, staffId);
    if (!staff) throw notFound('Staff');
    return staff;
  };

  const notifyPaid = (orgId, payment) =>
    notificationService.notifyStaff(orgId, payment.staffId?._id || payment.staffId, {
      type: 'payment',
      title: `Wages paid: ${rupees(netAmountOf(payment))}`,
      body: `For ${shortDate(payment.periodStart)} – ${shortDate(payment.periodEnd)}. Your payslip is ready.`,
      link: `/me/payslips/${payment._id}`,
    });

  return {
    preview: async (orgId, { staffId, periodStart, periodEnd }) => {
      const staff = await loadStaff(orgId, staffId);
      const { start, end } = requireRange(periodStart, periodEnd);
      await wageService.assertNoOverlap(orgId, staff._id, start, end);
      const [calc, advanceBalance] = await Promise.all([
        wageService.calcBreakdown(staff, start, end, orgId),
        wageService.advanceBalanceFor(orgId, staff._id),
      ]);
      const { passwordHash, tokenVersion, ...publicStaff } = staff;
      return { staff: publicStaff, ...calc, advanceBalance, periodStart: start, periodEnd: startOfDay(end) };
    },

    // Creates a pending payment, or a paid one in a single step when markPaid is true.
    create: async (orgId, input) => {
      const staff = await loadStaff(orgId, input.staffId);
      const { start, end } = requireRange(input.periodStart, input.periodEnd);
      const payment = await wageService.createPayment({
        orgId,
        staff,
        start,
        end,
        bonus: toNumber(input.bonus, 'Bonus'),
        deductions: toNumber(input.deductions, 'Deductions'),
        advanceDeducted: toNumber(input.advanceDeducted, 'Advance recovery'),
        note: input.note,
        markPaid: input.markPaid,
        paymentMode: input.paymentMode,
        paidDate: input.paidDate,
        ...(input.markPaid ? await proofFields(orgId, input) : {}),
      });
      if (payment.status === 'paid') notifyPaid(orgId, payment);
      return payment;
    },

    markPaid: async (orgId, id, { paymentMode, note, paidDate, transactionRef, proof }) => {
      wageService.assertPaymentMode(paymentMode);
      const existing = await paymentRepo.findById(orgId, id);
      if (!existing) throw notFound('Payment');
      if (existing.status === 'paid') throw invalid('Payment is already marked as paid');
      const set = { paymentMode, paidDate: paidDate ? requireDay(paidDate, 'paidDate') : new Date() };
      if (note) set.note = note;
      Object.assign(set, await proofFields(orgId, { transactionRef, proof }));
      const payment = await paymentRepo.markPaid(orgId, id, set);
      notifyPaid(orgId, payment);
      return payment;
    },

    // Only pending payments can be cancelled; this also releases their days and advance recovery.
    cancel: async (orgId, id) => {
      const payment = await paymentRepo.findById(orgId, id);
      if (!payment) throw notFound('Payment');
      if (payment.status === 'paid') throw invalid('Paid payments cannot be cancelled');
      await paymentRepo.remove(payment._id);
      return { message: 'Pending payment cancelled' };
    },

    list: (orgId, { staffId, status, from, to } = {}) => {
      const filters = { status };
      if (staffId) filters.staffId = requireId(staffId, 'staffId');
      if (from && to) Object.assign(filters, requireRange(from, to, 'from', 'to'));
      return paymentRepo.list(orgId, filters);
    },

    outstanding: (orgId, { staffId } = {}) => {
      if (staffId) requireId(staffId, 'staffId');
      return wageService.computeOutstanding(orgId, { staffId });
    },

    // Slip data: the payment, the business profile and the worker's attendance in the period.
    // `ownerStaffId` restricts access to that worker's own slips (staff app).
    slip: async (orgId, id, { ownerStaffId } = {}) => {
      requireId(id, 'payment id');
      const [payment, organization] = await Promise.all([paymentRepo.findDetailed(orgId, id), orgRepo.findById(orgId)]);
      if (!payment) throw notFound('Payment');
      const staffId = payment.staffId?._id || payment.staffId;
      if (ownerStaffId && String(staffId) !== String(ownerStaffId)) throw forbidden();
      const attendance = await attendanceRepo.statusCounts(orgId, staffId, payment.periodStart, endOfDay(payment.periodEnd));
      return { ...payment, organization, attendance };
    },

    // The proof screenshot of a payment (staff may only see their own).
    proof: async (orgId, id, { ownerStaffId } = {}) => {
      requireId(id, 'payment id');
      const payment = await paymentRepo.findById(orgId, id);
      if (!payment || !payment.proofId) throw notFound('Proof');
      if (ownerStaffId && String(payment.staffId) !== String(ownerStaffId)) throw forbidden();
      const file = await attachmentRepo.findWithData(orgId, payment.proofId);
      if (!file) throw notFound('Proof');
      return { contentType: file.contentType, data: file.data };
    },

    notifyPaid,
  };
};
