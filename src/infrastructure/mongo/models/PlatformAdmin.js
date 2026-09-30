const mongoose = require('mongoose');

// Operators of the SaaS itself (the platform portal). They belong to no organization and can
// list, create and suspend businesses. Created only from the command line (scripts/platform-admin.js).
const platformAdminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    phoneKey: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlatformAdmin', platformAdminSchema);
