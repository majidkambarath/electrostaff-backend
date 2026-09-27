const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MongoDB error: MONGODB_URI is not set in .env');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, {
      // Atlas-friendly defaults
      serverSelectionTimeoutMS: 15000,
      // On Windows, IPv6 routes can cause TLS "internal error" (alert 80)
      family: 4,
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB error: ${error.message}`);

    if (error.message.includes('SSL') || error.message.includes('tls')) {
      console.error(`
Atlas TLS troubleshooting:
  1. Network Access → add your current IP (or 0.0.0.0/0 for dev)
  2. If password has special chars (@ # : /), URL-encode it in MONGODB_URI
  3. Confirm cluster is not paused in Atlas
  4. Use: mongodb+srv://USER:PASS@cluster.../dbname?retryWrites=true&w=majority
`);
    }

    process.exit(1);
  }
};

module.exports = connectDB;
