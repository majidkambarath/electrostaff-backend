// Unit tests for pure domain rules — no database, no HTTP. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { siteAmount, otRateOf, buildBreakdown, netPayable } = require('../src/domain/wages');
const { skipReason, otFor, validateEntry, summarize } = require('../src/domain/attendance');
const { financeSummary } = require('../src/domain/finance');
const { normalizePhone, generatePassword, assertPassword } = require('../src/domain/credentials');
const { parseImageDataUrl, assertUpiId } = require('../src/domain/files');
const { startOfDay, requireRange } = require('../src/domain/dates');

test('wages: day wage + overtime, rounded per site', () => {
  const staff = { dailyWage: 555 };
  assert.equal(otRateOf(staff), 69); // 555 / 8 rounded
  assert.equal(otRateOf({ dailyWage: 555, otRate: 0 }), 0); // explicit 0 = no OT pay
  assert.equal(siteAmount(staff, { presentDays: 2, halfDays: 1, otHours: 0 }), 1388); // 1387.5 -> 1388
  const b = buildBreakdown(staff, [
    { siteId: 'a', siteName: 'A', status: 'present', otHours: 2 },
    { siteId: 'a', siteName: 'A', status: 'half', otHours: 0 },
    { siteId: 'b', siteName: 'B', status: 'half', otHours: 0 },
  ]);
  assert.equal(b.breakdown.length, 2);
  assert.equal(b.totalDays, 2);
  assert.equal(b.totalAmount, siteAmount(staff, { presentDays: 1, halfDays: 1, otHours: 2 }) + siteAmount(staff, { halfDays: 1 }));
});

test('wages: net payable guards', () => {
  assert.deepEqual(netPayable({ gross: 1000, bonus: 100, deductions: 50, advanceDeducted: 200, advanceBalance: 500 }), { net: 850 });
  assert.match(netPayable({ gross: 1000, advanceDeducted: 600, advanceBalance: 500 }).error, /can't exceed/);
  assert.match(netPayable({ gross: 100, deductions: 200 }).error, /exceed the wages/);
});

test('attendance: one payable day per person across sites', () => {
  assert.equal(skipReason({ assigned: false, status: 'present' }), 'Not assigned to this site');
  assert.match(skipReason({ assigned: true, lockedBy: 'paid', status: 'present' }), /paid payment/);
  assert.match(skipReason({ assigned: true, status: 'present', elsewhere: { units: 1, sites: ['X'] } }), /Already worked at X/);
  assert.equal(skipReason({ assigned: true, status: 'half', elsewhere: { units: 0.5, sites: ['X'] } }), null);
  assert.equal(otFor('absent', 4), 0);
  assert.throws(() => validateEntry({ status: 'present', otHours: 17 }), /between 0 and 16/);
  assert.equal(summarize([{ status: 'present' }, { status: 'half', otHours: 2 }]).payableDays, 1.5);
});

test('finance: profit from contract, else from receipts', () => {
  assert.deepEqual(financeSummary({ contractValue: 100, received: 40, labourCost: 50, expenses: 10 }), {
    contractValue: 100, received: 40, due: 60, labourCost: 50, expenses: 10, totalCost: 60, profit: 40, margin: 40,
  });
  assert.equal(financeSummary({ received: 40, labourCost: 50 }).profit, -10);
});

test('credentials: phone normalisation and passwords', () => {
  assert.equal(normalizePhone('+91 98450-12345'), '9845012345');
  assert.equal(generatePassword().length, 8);
  assert.doesNotMatch(generatePassword(200), /[01ilo]/);
  assert.throws(() => assertPassword('12345'), /at least 6/);
});

test('files: proof images are checked by content, not label', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(parseImageDataUrl(png).contentType, 'image/png');
  assert.throws(() => parseImageDataUrl('data:image/png;base64,AAAA'), /not a valid image/);
  assert.throws(() => parseImageDataUrl('data:text/html;base64,AAAA'), /JPEG, PNG or WebP/);
  assert.throws(() => assertUpiId('bad upi'), /valid UPI ID/);
  assert.doesNotThrow(() => assertUpiId('ravi.k@okaxis'));
});

test('dates: YYYY-MM-DD is a local calendar day', () => {
  const d = startOfDay('2026-09-27');
  assert.equal(d.getDate(), 27);
  assert.throws(() => requireRange('2026-09-10', '2026-09-01'), /on or after/);
});
