// Creates a platform operator (platform portal login), or resets its password if it exists.
//   npm run platform-admin -- <mobile> <password> "<name>"
// The number must not already sign in to a business. Uses MONGODB_URI from .env.
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config');
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const { buildContainer } = require('../src/container');

const run = async () => {
  const [phone, password, name = 'Platform admin'] = process.argv.slice(2);
  if (!phone || !password) {
    console.error('Usage: npm run platform-admin -- <mobile> <password> "<name>"');
    process.exit(1);
  }
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  try {
    const result = await buildContainer(config).authService.upsertPlatformAdmin({ name, phone, password });
    console.log(
      result.created
        ? `Platform admin ${result.name} created. Sign in with ${result.phone} to open the platform portal.`
        : `Password reset for platform admin ${result.name} (${result.phone}); other devices are signed out.`
    );
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
