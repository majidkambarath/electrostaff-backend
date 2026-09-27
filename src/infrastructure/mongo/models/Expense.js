const mongoose = require('mongoose');

// Money spent other than wages: materials, transport, tools... Linked to a site, or general
// business overhead when siteId is empty.
const expenseSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },
    category: {
      type: String,
      enum: ['material', 'transport', 'tools', 'food', 'rent', 'other'],
      default: 'material',
    },
    amount: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    description: { type: String, trim: true },
    vendor: { type: String, trim: true },
    paymentMode: { type: String, enum: ['cash', 'upi', 'bank'], default: 'cash' },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

expenseSchema.index({ organizationId: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
