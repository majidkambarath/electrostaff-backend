const mongoose = require('mongoose');

// A batch of payments created together for one period (e.g. the Saturday payday).
// The payments themselves hold the money; the run groups them for the payroll sheet.
const payrollRunSchema = new mongoose.Schema(
  {
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
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

module.exports = mongoose.model('PayrollRun', payrollRunSchema);
