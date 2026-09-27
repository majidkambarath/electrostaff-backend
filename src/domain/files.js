const { invalid } = require('./errors');

// Accepted proof images, identified by their leading "magic" bytes — the declared type
// is never trusted on its own.
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};
const MAX_BYTES = 2 * 1024 * 1024;

// "data:image/jpeg;base64,...." -> { contentType, data: Buffer }
const parseImageDataUrl = (dataUrl) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw invalid('Proof must be a JPEG, PNG or WebP image');
  const [, contentType, base64] = match;
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0 || data.length > MAX_BYTES) throw invalid('Proof image must be smaller than 2 MB');
  if (!SIGNATURES[contentType](data)) throw invalid('The uploaded file is not a valid image');
  return { contentType, data };
};

const UPI_ID = /^[a-z0-9.\-_]{2,256}@[a-z][a-z0-9.]{1,64}$/i;
const assertUpiId = (value) => {
  if (value && !UPI_ID.test(value)) throw invalid('Enter a valid UPI ID, like name@okaxis');
};

module.exports = { parseImageDataUrl, assertUpiId, MAX_BYTES };
