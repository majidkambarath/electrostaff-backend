const { requireId, toNumber } = require('../validation');
const { notFound, invalid } = require('../../domain/errors');
const { dayKey } = require('../../domain/dates');

const TYPES = ['advance', 'other'];
const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// Requests raised by workers in the staff app (e.g. an advance), decided by the office.
module.exports = ({ requestRepo, advanceService, notificationService }) => ({
  list: (orgId, { status, staffId } = {}) => requestRepo.list(orgId, { status, staffId }),

  create: async (orgId, staff, { type, amount, note }) => {
    if (!TYPES.includes(type)) throw invalid('Choose a request type');
    const value = type === 'advance' ? toNumber(amount, 'Amount', { min: 1 }) : undefined;
    const text = String(note || '').trim();
    if (type === 'other' && !text) throw invalid('Describe what you need');
    const request = await requestRepo.create({ staffId: staff.staffId, type, amount: value, note: text, organizationId: orgId });
    notificationService.notifyAdmins(orgId, {
      type: 'request',
      title: type === 'advance' ? `${staff.name} requested an advance of ${rupees(value)}` : `${staff.name} sent a request`,
      body: text || undefined,
      link: '/requests',
    });
    return request;
  },

  // Approving an advance request can record the advance in the same step.
  decide: async (orgId, id, { status, responseNote, recordAdvance = true, amount, paymentMode }) => {
    requireId(id, 'request id');
    if (!['approved', 'rejected'].includes(status)) throw invalid('Choose approve or reject');
    const request = await requestRepo.findById(orgId, id);
    if (!request) throw notFound('Request');
    if (request.status !== 'pending') throw invalid(`This request is already ${request.status}`);

    const set = { status, responseNote: responseNote?.trim() || undefined, decidedAt: new Date() };
    if (status === 'approved' && request.type === 'advance' && recordAdvance) {
      const advance = await advanceService.create(orgId, {
        staffId: String(request.staffId._id),
        amount: amount ?? request.amount,
        date: dayKey(new Date()),
        paymentMode: paymentMode || 'cash',
        note: `Approved request${request.note ? `: ${request.note}` : ''}`,
      });
      set.advanceId = advance._id;
    }
    const updated = await requestRepo.update(orgId, id, set);
    notificationService.notifyStaff(orgId, request.staffId._id, {
      type: 'request',
      title:
        request.type === 'advance'
          ? `Your advance request (${rupees(request.amount)}) was ${status}`
          : `Your request was ${status}`,
      body: set.responseNote,
      link: '/me/requests',
    });
    return updated;
  },

  // Staff app: a worker withdraws their own pending request.
  cancelOwn: async (orgId, staffId, id) => {
    requireId(id, 'request id');
    const request = await requestRepo.findById(orgId, id);
    if (!request || String(request.staffId._id) !== String(staffId)) throw notFound('Request');
    if (request.status !== 'pending') throw invalid('Only pending requests can be cancelled');
    return requestRepo.update(orgId, id, { status: 'cancelled', decidedAt: new Date() });
  },
});
