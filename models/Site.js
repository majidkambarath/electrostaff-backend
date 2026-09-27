const mongoose = require('mongoose');

const siteSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    clientName: { type: String, trim: true },
    clientPhone: { type: String, trim: true },
    startDate: { type: Date, required: true, default: Date.now },
    endDate: { type: Date },
    // Agreed job value with the client; drives dues and profit.
    contractValue: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['active', 'completed', 'onhold'],
      default: 'active',
    },
    notes: { type: String, trim: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Site', siteSchema);
