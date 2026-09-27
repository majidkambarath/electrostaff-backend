const mongoose = require('mongoose');

// A request raised by a worker from the staff app (e.g. an advance), decided by the office.
const staffRequestSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
    type: { type: String, enum: ['advance', 'other'], required: true },
    amount: { type: Number, min: 0 },
    note: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    responseNote: { type: String, trim: true },
    decidedAt: { type: Date },
    advanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advance' },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

staffRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('StaffRequest', staffRequestSchema);
