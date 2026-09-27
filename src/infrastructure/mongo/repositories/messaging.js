// Notifications and Web Push subscriptions.
const recipientFilter = (orgId, { audience, staffId }) => ({
  organizationId: orgId,
  audience,
  ...(audience === 'staff' && { staffId }),
});

module.exports = ({ Notification, PushSubscription }) => ({
  notificationRepo: {
    create: async (data) => (await Notification.create(data)).toObject(),
    list: (orgId, recipient, { limit = 30 } = {}) =>
      Notification.find(recipientFilter(orgId, recipient)).sort({ createdAt: -1 }).limit(limit).lean(),
    unreadCount: (orgId, recipient) => Notification.countDocuments({ ...recipientFilter(orgId, recipient), readAt: null }),
    markRead: (orgId, recipient, ids) =>
      Notification.updateMany(
        { ...recipientFilter(orgId, recipient), readAt: null, ...(ids?.length && { _id: { $in: ids } }) },
        { readAt: new Date() }
      ),
  },

  pushRepo: {
    save: (sub) =>
      PushSubscription.findOneAndUpdate({ endpoint: sub.endpoint }, sub, { upsert: true, new: true, runValidators: true }).lean(),
    removeEndpoint: (endpoint) => PushSubscription.deleteOne({ endpoint }),
    removeEndpoints: (endpoints) => PushSubscription.deleteMany({ endpoint: { $in: endpoints } }),
    forRecipient: (orgId, recipient) => PushSubscription.find(recipientFilter(orgId, recipient)).lean(),
  },
});
