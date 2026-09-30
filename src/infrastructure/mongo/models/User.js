const mongoose = require('mongoose');

// Office accounts of a business: owner, admins, and site supervisors (attendance only).
// Staff sign in through Staff.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    phoneKey: { type: String, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'admin', 'supervisor'], default: 'admin' },
    // Supervisors only see and mark attendance for these sites.
    siteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Site' }],
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

module.exports = mongoose.model('User', userSchema);
