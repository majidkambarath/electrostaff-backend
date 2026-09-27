const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    role: {
      type: String,
      enum: ['electrician', 'helper', 'supervisor', 'apprentice', 'other'],
      default: 'helper',
    },
    dailyWage: { type: Number, required: true, min: 0 },
    // Overtime pay per hour; when unset, services/wages.js uses dailyWage / 8.
    otRate: { type: Number, min: 0 },
    joinDate: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: ['active', 'inactive', 'on-leave'],
      default: 'active',
    },
    notes: { type: String, trim: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Staff', staffSchema);
