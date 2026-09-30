// Mongo adapters for every repository port the application layer uses.
const models = require('../models');

module.exports = () => ({
  ...require('./people')(models),
  ...require('./sites')(models),
  ...require('./attendance')(models),
  ...require('./money')(models),
  ...require('./hr')(models),
  ...require('./messaging')(models),
  ...require('./files')(models),
  ...require('./platform')(models),
});
