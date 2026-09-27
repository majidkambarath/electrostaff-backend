// Stored attachments (payment proofs).
module.exports = ({ Attachment }) => ({
  attachmentRepo: {
    create: async ({ organizationId, kind, contentType, data }) => {
      const doc = await Attachment.create({ organizationId, kind, contentType, data, size: data.length });
      return { _id: doc._id, contentType: doc.contentType, size: doc.size };
    },
    // Lean reads return BSON Binary; hand the application a plain Node Buffer.
    findWithData: async (orgId, id) => {
      const doc = await Attachment.findOne({ _id: id, organizationId: orgId }).select('+data').lean();
      if (!doc) return null;
      const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer);
      return { ...doc, data };
    },
  },
});
