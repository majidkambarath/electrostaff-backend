const mongoose = require('mongoose');

// Money received from the client for a site (advance, running bill, final settlement).
const clientReceiptSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    paymentMode: { type: String, enum: ['cash', 'upi', 'bank', 'cheque'], default: 'bank' },
    reference: { type: String, trim: true },
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

clientReceiptSchema.index({ organizationId: 1, date: -1 });

module.exports = mongoose.model('ClientReceipt', clientReceiptSchema);
