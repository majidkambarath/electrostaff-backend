const mongoose = require('mongoose');

const siteAssignmentSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
    assignedDate: { type: Date, required: true, default: Date.now },
    active: { type: Boolean, default: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

siteAssignmentSchema.index({ staffId: 1, siteId: 1 }, { unique: true });

module.exports = mongoose.model('SiteAssignment', siteAssignmentSchema);
