const { requireId, toNumber } = require('../validation');
const { requireDay } = require('../../domain/dates');
const { notFound, invalid } = require('../../domain/errors');

module.exports = ({ advanceRepo, staffRepo, wageService, notificationService }) => ({
  list: (orgId, { staffId } = {}) => advanceRepo.list(orgId, staffId ? requireId(staffId, 'staffId') : undefined),

  // Per-staff advance totals: given, recovered through payments, outstanding balance.
  balances: async (orgId) => {
    const balances = await wageService.advanceBalances(orgId);
    const staff = await staffRepo.findByIds([...balances.keys()], 'name role phone');
    return staff.map((s) => ({ staff: s, ...balances.get(String(s._id)) })).sort((a, b) => b.balance - a.balance);
  },

  create: async (orgId, { staffId, date, paymentMode, note, amount }) => {
    requireId(staffId, 'staffId');
    const value = toNumber(amount, 'Amount', { min: 1 });
    if (!(await staffRepo.findById(orgId, staffId))) throw notFound('Staff');
    const advance = await advanceRepo.create({
      staffId,
      amount: value,
      date: requireDay(date, 'date'),
      paymentMode,
      note,
      organizationId: orgId,
    });
    notificationService.notifyStaff(orgId, staffId, {
      type: 'advance',
      title: `Advance of ₹${value.toLocaleString('en-IN')} given`,
      body: 'It will be recovered from your upcoming wages.',
      link: '/me',
    });
    return advance;
  },

  // Removable only if the remaining advances still cover what payments already recovered.
  remove: async (orgId, id) => {
    requireId(id, 'advance id');
    const advance = await advanceRepo.findById(orgId, id);
    if (!advance) throw notFound('Advance');
    const balance = await wageService.advanceBalanceFor(orgId, advance.staffId);
    if (balance - advance.amount < 0) {
      throw invalid('Part of this advance was already recovered in a payment, so it cannot be deleted');
    }
    await advanceRepo.remove(advance._id);
    return { message: 'Advance deleted' };
  },
});
