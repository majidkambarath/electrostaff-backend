const mongoose = require('mongoose');

// In-app notification. audience 'admin' = the office of the organization; audience 'staff' =
// one worker (staffId). `link` is an app route to open when tapped.
const notificationSchema = new mongoose.Schema(
  {
    audience: { type: String, enum: ['admin', 'staff'], required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' },
    type: {
      type: String,
      enum: ['attendance', 'leave', 'request', 'payment', 'advance', 'system'],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    link: { type: String, trim: true },
    readAt: { type: Date, default: null },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ organizationId: 1, audience: 1, staffId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
