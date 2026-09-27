require('dotenv').config();
const { buildConfig } = require('./src/config');
const { connectMongo } = require('./src/infrastructure/mongo/connection');
const { buildContainer } = require('./src/container');
const { createApp } = require('./src/interfaces/http/app');

// Builds the app for a config (used by tests with an in-memory database).
const buildApp = (config = buildConfig()) => createApp(buildContainer(config), config);

const start = async () => {
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  buildApp(config).listen(config.port, () => console.log(`Server running on port ${config.port}`));
};

if (require.main === module) start();

module.exports = { buildApp };
