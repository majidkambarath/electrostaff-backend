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
    // Overtime pay per hour; when unset, domain/wages.js uses dailyWage / 8.
    otRate: { type: Number, min: 0 },
    joinDate: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: ['active', 'inactive', 'on-leave'],
      default: 'active',
    },
    notes: { type: String, trim: true },
    // UPI ID (e.g. name@okaxis) used to open a UPI app with wages prefilled.
    upiId: { type: String, trim: true, lowercase: true },
    // Staff app (portal) access. phoneKey = last 10 digits of phone, used to sign in.
    phoneKey: { type: String },
    portalEnabled: { type: Boolean, default: false },
    passwordHash: { type: String, select: false },
    mustChangePassword: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// A login number belongs to one account on the whole platform (office users are checked in code).
staffSchema.index({ phoneKey: 1 }, { unique: true, partialFilterExpression: { portalEnabled: true }, name: 'unique_login_phone' });

module.exports = mongoose.model('Staff', staffSchema);
