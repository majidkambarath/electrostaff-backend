const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
    date: { type: Date, required: true },
    status: {
      type: String,
      enum: ['present', 'absent', 'half', 'leave'],
      default: 'present',
    },
    // Overtime hours; only counted for present/half days.
    otHours: { type: Number, default: 0, min: 0, max: 16 },
    // Who marked it: the office (admin) or the worker themselves from the staff app.
    source: { type: String, enum: ['admin', 'staff'], default: 'admin' },
    checkIn: {
      at: { type: Date },
      lat: { type: Number },
      lng: { type: Number },
      accuracy: { type: Number },
      distance: { type: Number }, // metres from the site's geofence centre
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

attendanceSchema.index({ staffId: 1, siteId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ organizationId: 1, date: 1 });
attendanceSchema.index({ organizationId: 1, siteId: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
