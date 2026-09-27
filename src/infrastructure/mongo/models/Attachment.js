const mongoose = require('mongoose');

// Small uploaded files (payment proof screenshots). Stored in MongoDB so the app needs no
// separate file storage; the API limits them to compressed images of a few hundred KB.
const attachmentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['payment-proof'], required: true },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true, select: false },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Attachment', attachmentSchema);
