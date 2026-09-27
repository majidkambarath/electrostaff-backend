const crypto = require('crypto');
const { invalid } = require('./errors');

// Phone numbers are compared on their last 10 digits so "+91 98450 12345", "098450-12345"
// and "9845012345" all identify the same person.
const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const MIN_PASSWORD = 6;

const assertPassword = (password) => {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw invalid(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 72) throw invalid('Password is too long');
};

// Easy to read aloud / type on a phone: no 0/O, 1/l/I.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const generatePassword = (length = 8) =>
  Array.from(crypto.randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join('');

module.exports = { normalizePhone, assertPassword, generatePassword, MIN_PASSWORD };
