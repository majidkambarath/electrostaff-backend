// Adapter for the pushNotifier port (Web Push / VAPID). Without keys it is a no-op, so the rest of
// the app never has to care whether push is configured.
const makeWebPushNotifier = ({ publicKey, privateKey, subject }) => {
  if (!publicKey || !privateKey) {
    return { enabled: false, publicKey: null, send: async () => [] };
  }
  const webpush = require('web-push');
  webpush.setVapidDetails(subject, publicKey, privateKey);

  return {
    enabled: true,
    publicKey,
    // Sends to every subscription; returns endpoints that are gone (to be deleted).
    send: async (subscriptions, payload) => {
      const gone = [];
      const body = JSON.stringify(payload);
      await Promise.all(
        subscriptions.map((sub) =>
          webpush
            .sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 60 * 60 * 24 })
            .catch((err) => {
              if (err.statusCode === 404 || err.statusCode === 410) gone.push(sub.endpoint);
            })
        )
      );
      return gone;
    },
  };
};

module.exports = { makeWebPushNotifier };
