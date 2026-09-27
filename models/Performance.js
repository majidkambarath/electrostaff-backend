const mongoose = require('mongoose');

const performanceSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    tasksCompleted: { type: Number, default: 0, min: 0 },
    punctuality: { type: Number, min: 1, max: 5, default: 3 },
    quality: { type: Number, min: 1, max: 5, default: 3 },
    notes: { type: String, trim: true },
    // Optional for ratings created before multi-tenancy.
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  },
  { timestamps: true }
);

performanceSchema.index({ staff: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Performance', performanceSchema);
