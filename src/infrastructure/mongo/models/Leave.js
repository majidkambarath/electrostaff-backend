const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    type: {
      type: String,
      enum: ['sick', 'casual', 'paid', 'unpaid', 'other'],
      default: 'casual',
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    reason: { type: String, trim: true },
    days: { type: Number, default: 1 },
    // Entered by the office, or applied for by the worker in the staff app.
    source: { type: String, enum: ['admin', 'staff'], default: 'admin' },
    responseNote: { type: String, trim: true },
    decidedAt: { type: Date },
    // Optional for leaves created before multi-tenancy.
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  },
  { timestamps: true }
);

leaveSchema.index({ staff: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('Leave', leaveSchema);
