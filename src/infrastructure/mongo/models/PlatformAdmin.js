const mongoose = require('mongoose');

// Developers / operators of the SaaS (developer mode). They belong to no organization and can
// list, create and block businesses. Created only from the command line (scripts/platform-admin.js)
// and sign in with a username, never through the mobile-number sign-in.
const platformAdminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlatformAdmin', platformAdminSchema);
