const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Secrets come from the environment; anything missing is generated once and kept in
// backend/.secrets.json (git-ignored) so sign-ins and push subscriptions survive restarts.
const SECRETS_FILE = path.join(__dirname, '..', '..', '.secrets.json');

const loadSecrets = () => {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  let changed = false;
  if (!process.env.JWT_SECRET && !stored.jwtSecret) {
    stored.jwtSecret = crypto.randomBytes(48).toString('hex');
    changed = true;
  }
  if (!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) && !stored.vapid) {
    try {
      stored.vapid = require('web-push').generateVAPIDKeys();
      changed = true;
    } catch {
      // web-push unavailable: push notifications are simply disabled
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2));
    } catch (err) {
      console.warn(`Could not save ${SECRETS_FILE}: ${err.message}. Sessions will reset on restart.`);
    }
  }
  return stored;
};

// Express reads a string as an IP list, so hop counts and booleans must be real numbers/booleans.
const parseTrustProxy = (value) => {
  if (!value) return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
};

const buildConfig = (env = process.env) => {
  const secrets = loadSecrets();
  return {
    port: Number(env.PORT) || 5000,
    mongoUri: env.MONGODB_URI,
    // Public "Create your business" sign-up. Set SIGNUP_ENABLED=false to close it (the platform portal can still create businesses).
    signupEnabled: env.SIGNUP_ENABLED !== 'false',
    jwtSecret: env.JWT_SECRET || secrets.jwtSecret,
    tokenTtl: env.TOKEN_TTL || '30d',
    // Comma-separated list of allowed browser origins (empty = allow any, e.g. dev over LAN).
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE) || 300,
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 50,
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || secrets.vapid?.publicKey || null,
      privateKey: env.VAPID_PRIVATE_KEY || secrets.vapid?.privateKey || null,
      subject: env.VAPID_SUBJECT || 'mailto:admin@electrostaff.local',
    },
  };
};

module.exports = { buildConfig };
