const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    ownerName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    // Set from the platform portal; a suspended business cannot sign in.
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    // Subscription (set in developer mode). No plan = no limits (businesses from before plans).
    plan: {
      type: new mongoose.Schema(
        { name: { type: String, enum: ['trial', 'starter', 'pro', 'custom'] }, staffLimit: Number, validUntil: Date },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
