const { invalid } = require('../../domain/errors');

// In-app notifications + Web Push. Recipients are either the office of an organization
// ({ audience: 'admin' }) or one worker ({ audience: 'staff', staffId }).
module.exports = ({ notificationRepo, pushRepo, pushNotifier }) => {
  const recipientOf = (principal) =>
    principal.role === 'staff' ? { audience: 'staff', staffId: principal.staffId } : { audience: 'admin' };

  // Fire-and-forget: a failing push must never break the action that triggered it.
  const deliver = async (orgId, recipient, { type, title, body, link }) => {
    const notification = await notificationRepo.create({ organizationId: orgId, ...recipient, type, title, body, link });
    if (pushNotifier.enabled) {
      pushRepo
        .forRecipient(orgId, recipient)
        .then((subs) => (subs.length ? pushNotifier.send(subs, { title, body, link, tag: String(notification._id) }) : []))
        .then((gone) => gone.length && pushRepo.removeEndpoints(gone))
        .catch((err) => console.error('Push failed:', err.message));
    }
    return notification;
  };

  return {
    notifyAdmins: (orgId, message) => deliver(orgId, { audience: 'admin' }, message).catch((e) => console.error(e.message)),
    notifyStaff: (orgId, staffId, message) =>
      deliver(orgId, { audience: 'staff', staffId }, message).catch((e) => console.error(e.message)),

    list: async (principal) => {
      const recipient = recipientOf(principal);
      const [items, unread] = await Promise.all([
        notificationRepo.list(principal.organizationId, recipient),
        notificationRepo.unreadCount(principal.organizationId, recipient),
      ]);
      return { items, unread };
    },
    unreadCount: async (principal) => ({
      unread: await notificationRepo.unreadCount(principal.organizationId, recipientOf(principal)),
    }),
    markRead: async (principal, ids) => {
      await notificationRepo.markRead(principal.organizationId, recipientOf(principal), Array.isArray(ids) ? ids : null);
      return { ok: true };
    },

    pushKey: () => ({ enabled: pushNotifier.enabled, publicKey: pushNotifier.publicKey }),
    subscribe: async (principal, subscription) => {
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        throw invalid('Invalid push subscription');
      }
      const recipient = recipientOf(principal);
      await pushRepo.save({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        ...recipient,
        userId: principal.role === 'staff' ? undefined : principal.id,
        organizationId: principal.organizationId,
      });
      return { ok: true };
    },
    unsubscribe: async (principal, endpoint) => {
      if (endpoint) await pushRepo.removeEndpoint(principal.organizationId, recipientOf(principal), endpoint);
      return { ok: true };
    },
  };
};
