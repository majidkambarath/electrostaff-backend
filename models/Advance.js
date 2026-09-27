const mongoose = require('mongoose');

// Money given to a staff member ahead of wages. The outstanding balance per staff is
// sum(advances) - sum(payment.advanceDeducted); see services/wages.js.
const advanceSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    amount: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    paymentMode: { type: String, enum: ['cash', 'upi', 'bank'], default: 'cash' },
    note: { type: String, trim: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

advanceSchema.index({ organizationId: 1, staffId: 1, date: -1 });

module.exports = mongoose.model('Advance', advanceSchema);
