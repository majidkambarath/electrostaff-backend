// Wage rules — pure functions, no I/O.
//   site amount = round(dailyWage × (present + ½ × half) + otRate × otHours)
// Rounding happens per site so previews, payments, payroll, outstanding figures and
// reports always agree to the rupee.
const PAYABLE_STATUSES = ['present', 'half'];
const PAYABLE_UNITS = { present: 1, half: 0.5 };

const payableUnits = (status) => PAYABLE_UNITS[status] || 0;

// Overtime rate per hour: the staff member's own rate, or a day's wage spread over 8 hours.
const otRateOf = (staff) =>
  staff.otRate !== undefined && staff.otRate !== null ? staff.otRate : Math.round((staff.dailyWage || 0) / 8);

const siteAmount = (staff, { presentDays = 0, halfDays = 0, otHours = 0 }) =>
  Math.round((staff.dailyWage || 0) * (presentDays + halfDays * 0.5) + otRateOf(staff) * otHours);

// Unrounded day wage + overtime for one attendance record (used for trend charts).
const recordEarning = (staff, record) => {
  const units = payableUnits(record.status);
  return staff && units ? staff.dailyWage * units + otRateOf(staff) * (record.otHours || 0) : 0;
};

const netAmountOf = (payment) => payment.netAmount ?? payment.totalAmount;

const emptyCounts = () => ({ presentDays: 0, halfDays: 0, otHours: 0 });

const addRecord = (counts, record) => {
  if (record.status === 'present') counts.presentDays += 1;
  else if (record.status === 'half') counts.halfDays += 1;
  counts.otHours += record.otHours || 0;
};

// Per-site breakdown for one staff member from their payable attendance records.
// records: [{ siteId, siteName, status, otHours }]
const buildBreakdown = (staff, records) => {
  const bySite = new Map();
  for (const r of records) {
    const key = String(r.siteId);
    if (!bySite.has(key)) bySite.set(key, { siteId: r.siteId, siteName: r.siteName || 'Removed site', ...emptyCounts() });
    addRecord(bySite.get(key), r);
  }
  const otRate = otRateOf(staff);
  const breakdown = [...bySite.values()].map((item) => ({
    ...item,
    otAmount: Math.round(otRate * item.otHours),
    amount: siteAmount(staff, item),
  }));
  return {
    breakdown,
    otRate,
    totalDays: breakdown.reduce((s, b) => s + b.presentDays + b.halfDays * 0.5, 0),
    otHours: breakdown.reduce((s, b) => s + b.otHours, 0),
    otAmount: breakdown.reduce((s, b) => s + b.otAmount, 0),
    totalAmount: breakdown.reduce((s, b) => s + b.amount, 0),
  };
};

// Net handed over after adjustments; throws a message when a rule is broken.
const netPayable = ({ gross, bonus = 0, deductions = 0, advanceDeducted = 0, advanceBalance = 0 }) => {
  if (advanceDeducted > advanceBalance) {
    return { error: `Advance recovery can't exceed the outstanding advance of ₹${advanceBalance}` };
  }
  const net = gross + bonus - deductions - advanceDeducted;
  if (net < 0) return { error: 'Deductions and advance recovery exceed the wages for this period' };
  return { net };
};

module.exports = {
  PAYABLE_STATUSES,
  PAYABLE_UNITS,
  payableUnits,
  otRateOf,
  siteAmount,
  recordEarning,
  netAmountOf,
  emptyCounts,
  addRecord,
  buildBreakdown,
  netPayable,
};
