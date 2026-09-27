const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Adapters for the passwordHasher and tokenService ports.
const makePasswordHasher = ({ rounds = 10 } = {}) => ({
  hash: (plain) => bcrypt.hash(plain, rounds),
  verify: (plain, hash) => (hash ? bcrypt.compare(plain, hash) : Promise.resolve(false)),
});

const makeTokenService = ({ secret, ttl = '30d' }) => ({
  sign: (claims) => jwt.sign(claims, secret, { expiresIn: ttl }),
  // Returns the claims, or null when the token is invalid or expired.
  verify: (token) => {
    try {
      return jwt.verify(token, secret);
    } catch {
      return null;
    }
  },
});

module.exports = { makePasswordHasher, makeTokenService };
