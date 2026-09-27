// Domain/application errors. They carry an HTTP-agnostic `code`; the HTTP adapter maps codes
// to status codes, so business code never deals with HTTP.
class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const invalid = (message) => new DomainError('INVALID', message);
const notFound = (what) => new DomainError('NOT_FOUND', `${what} not found`);
const conflict = (message) => new DomainError('CONFLICT', message);
const unauthorized = (message = 'Please sign in') => new DomainError('UNAUTHORIZED', message);
const forbidden = (message = 'You do not have access to this') => new DomainError('FORBIDDEN', message);
const tooMany = (message) => new DomainError('RATE_LIMITED', message);

module.exports = { DomainError, invalid, notFound, conflict, unauthorized, forbidden, tooMany };
