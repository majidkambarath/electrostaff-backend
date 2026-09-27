// Resets a forgotten owner/admin password from the server's command line.
//   npm run reset-password -- <mobile> <new-password>
// Uses the same use case and database as the API (MONGODB_URI from .env).
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config');
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const { buildContainer } = require('../src/container');

const run = async () => {
  const [phone, password] = process.argv.slice(2);
  if (!phone || !password) {
    console.error('Usage: npm run reset-password -- <mobile> <new-password>');
    process.exit(1);
  }
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  try {
    const { name, role } = await buildContainer(config).authService.resetOfficePassword(phone, password);
    console.log(`Password reset for ${name} (${role}). Sign in with the new password; other devices are signed out.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
