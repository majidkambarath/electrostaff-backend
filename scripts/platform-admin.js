// Creates a developer account (developer mode on the sign-in screen: Ctrl+Shift+D), or resets its
// password if the username exists.
//   npm run platform-admin -- <username> <password> ["<name>"]
// Uses MONGODB_URI from .env.
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config');
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const { buildContainer } = require('../src/container');

const run = async () => {
  const [username, password, name] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run platform-admin -- <username> <password> ["<name>"]');
    process.exit(1);
  }
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  try {
    const result = await buildContainer(config).authService.upsertPlatformAdmin({ username, password, name });
    console.log(
      result.created
        ? `Developer "${result.username}" created. On the sign-in screen press Ctrl+Shift+D (or tap the logo 7 times) to sign in.`
        : `Password reset for developer "${result.username}"; other devices are signed out.`
    );
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
