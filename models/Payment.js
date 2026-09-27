const mongoose = require('mongoose');

const breakdownSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
    presentDays: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    otHours: { type: Number, default: 0 },
    otAmount: { type: Number, default: 0 },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

// totalAmount is the gross wage earned from attendance (day wages + overtime). netAmount is what is handed over:
// totalAmount + bonus - deductions - advanceDeducted. Payments created before adjustments
// existed have no netAmount; treat it as totalAmount.
const paymentSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    breakdown: [breakdownSchema],
    dailyWage: { type: Number, min: 0 },
    otRate: { type: Number, min: 0 },
    otHours: { type: Number, default: 0 },
    otAmount: { type: Number, default: 0 },
    totalDays: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    bonus: { type: Number, default: 0, min: 0 },
    deductions: { type: Number, default: 0, min: 0 },
    advanceDeducted: { type: Number, default: 0, min: 0 },
    netAmount: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'paid'],
      default: 'pending',
    },
    paidDate: { type: Date },
    paymentMode: {
      type: String,
      enum: ['cash', 'upi', 'bank'],
    },
    note: { type: String, trim: true },
    payrollRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', index: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ staffId: 1, periodStart: 1, periodEnd: 1, organizationId: 1 });
paymentSchema.index({ organizationId: 1, status: 1, paidDate: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
