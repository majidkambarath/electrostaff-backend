const { pick, requireId, toNumber } = require('../validation');
const { requireDay, requireRange } = require('../../domain/dates');
const { notFound } = require('../../domain/errors');

const EXPENSE_FIELDS = ['siteId', 'category', 'description', 'vendor', 'paymentMode'];

// Expenses (site or general) and client receipts.
module.exports = ({ expenseRepo, receiptRepo, siteRepo }) => {
  const assertSite = async (orgId, siteId) => {
    requireId(siteId, 'siteId');
    if (!(await siteRepo.exists(orgId, siteId))) throw notFound('Site');
  };

  const expenseData = async (orgId, input, { partial = false } = {}) => {
    const data = pick(input, EXPENSE_FIELDS);
    if (data.siteId === '' || data.siteId === 'general') data.siteId = null;
    if (data.siteId) await assertSite(orgId, data.siteId);
    if (!partial || input.amount !== undefined) data.amount = toNumber(input.amount, 'Amount', { min: 1 });
    if (!partial || input.date !== undefined) data.date = requireDay(input.date, 'date');
    return data;
  };

  const range = (from, to) => (from && to ? requireRange(from, to, 'from', 'to') : {});

  return {
    expenses: {
      list: (orgId, { siteId, category, from, to } = {}) =>
        expenseRepo.list(orgId, {
          general: siteId === 'general',
          siteId: siteId && siteId !== 'general' ? requireId(siteId, 'siteId') : undefined,
          category,
          ...range(from, to),
        }),
      create: async (orgId, input) => expenseRepo.create({ ...(await expenseData(orgId, input)), organizationId: orgId }),
      update: async (orgId, id, input) => {
        requireId(id, 'expense id');
        const expense = await expenseRepo.update(orgId, id, await expenseData(orgId, input, { partial: true }));
        if (!expense) throw notFound('Expense');
        return expense;
      },
      remove: async (orgId, id) => {
        requireId(id, 'expense id');
        if (!(await expenseRepo.remove(orgId, id))) throw notFound('Expense');
        return { message: 'Expense deleted' };
      },
    },

    receipts: {
      list: (orgId, { siteId, from, to } = {}) =>
        receiptRepo.list(orgId, { siteId: siteId ? requireId(siteId, 'siteId') : undefined, ...range(from, to) }),
      create: async (orgId, input) => {
        await assertSite(orgId, input.siteId);
        return receiptRepo.create({
          ...pick(input, ['siteId', 'paymentMode', 'reference', 'note']),
          amount: toNumber(input.amount, 'Amount', { min: 1 }),
          date: requireDay(input.date, 'date'),
          organizationId: orgId,
        });
      },
      remove: async (orgId, id) => {
        requireId(id, 'receipt id');
        if (!(await receiptRepo.remove(orgId, id))) throw notFound('Receipt');
        return { message: 'Client payment deleted' };
      },
    },
  };
};
