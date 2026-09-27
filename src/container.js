// Composition root: the only place that knows which adapters implement which ports.
const makeRepositories = require('./infrastructure/mongo/repositories');
const { makePasswordHasher, makeTokenService } = require('./infrastructure/security');
const { makeWebPushNotifier } = require('./infrastructure/webPushNotifier');

const services = require('./application/services');

const buildContainer = (config) => {
  const repos = makeRepositories();
  const passwordHasher = makePasswordHasher();
  const tokenService = makeTokenService({ secret: config.jwtSecret, ttl: config.tokenTtl });
  const pushNotifier = makeWebPushNotifier(config.vapid);

  const c = { ...repos, passwordHasher, tokenService, pushNotifier, config };
  c.orgService = services.orgService(c);
  c.notificationService = services.notificationService(c);
  c.wageService = services.wageService(c);
  c.authService = services.authService(c);
  c.staffService = services.staffService(c);
  c.siteService = services.siteService(c);
  c.attendanceService = services.attendanceService(c);
  c.paymentService = services.paymentService(c);
  c.payrollService = services.payrollService(c);
  c.advanceService = services.advanceService(c);
  c.leaveService = services.leaveService(c);
  c.performanceService = services.performanceService(c);
  c.siteMoneyService = services.siteMoneyService(c);
  c.requestService = services.requestService(c);
  c.reportService = services.reportService(c);
  c.dashboardService = services.dashboardService(c);
  c.portalService = services.portalService(c);
  return c;
};

module.exports = { buildContainer };
