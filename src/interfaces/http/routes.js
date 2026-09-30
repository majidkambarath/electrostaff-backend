const express = require('express');
const { handle, sendFile, authenticate, requireRole } = require('./middleware');

// HTTP adapter: maps routes to use cases. Handlers only translate request -> command and
// never contain business rules.
module.exports = (s) => {
  const api = express.Router();
  const created = 201;

  // ---- Public ------------------------------------------------------------
  api.get('/health', (req, res) => res.json({ status: 'ok', message: 'Electro Staff API running' }));
  api.get('/auth/status', handle(() => s.authService.status()));
  api.post('/auth/signup', handle((req) => s.authService.signup(req.body), created));
  api.post('/auth/login', handle((req) => s.authService.login(req.body)));
  api.post('/auth/developer-login', handle((req) => s.authService.platformLogin(req.body)));

  // ---- Any signed-in user -------------------------------------------------
  api.use(authenticate(s.authService));
  api.get('/auth/me', handle(async (req) => ({
    principal: req.principal,
    organization: req.orgId ? await s.orgService.get(req.orgId) : null,
  })));
  api.post('/auth/change-password', handle((req) => s.authService.changePassword(req.principal, req.body)));

  // ---- Platform portal (SaaS operators) ------------------------------------
  const platform = express.Router();
  platform.use(requireRole('platform'));
  platform.get('/overview', handle(() => s.platformService.overview()));
  platform.get('/organizations', handle(() => s.platformService.list()));
  platform.post('/organizations', handle((req) => s.platformService.create(req.body), created));
  platform.get('/organizations/:id', handle((req) => s.platformService.get(req.params.id)));
  platform.put('/organizations/:id/status', handle((req) => s.platformService.setStatus(req.params.id, req.body.status)));
  api.use('/platform', platform);

  // Everything below belongs to one organization; platform operators have none.
  api.use(requireRole('owner', 'admin', 'staff'));

  api.get('/notifications', handle((req) => s.notificationService.list(req.principal)));
  api.get('/notifications/unread-count', handle((req) => s.notificationService.unreadCount(req.principal)));
  api.post('/notifications/read', handle((req) => s.notificationService.markRead(req.principal, req.body.ids)));
  api.get('/notifications/push-key', handle(() => s.notificationService.pushKey()));
  api.post('/notifications/subscribe', handle((req) => s.notificationService.subscribe(req.principal, req.body.subscription)));
  api.post('/notifications/unsubscribe', handle((req) => s.notificationService.unsubscribe(req.principal, req.body.endpoint)));

  // ---- Staff app (/me) ----------------------------------------------------
  const me = express.Router();
  me.use(requireRole('staff'));
  me.get('/home', handle((req) => s.portalService.home(req.principal)));
  me.post('/check-in', handle((req) => s.portalService.checkIn(req.principal, req.body), created));
  me.post('/check-in/undo', handle((req) => s.portalService.undoCheckIn(req.principal, req.body)));
  me.get('/attendance', handle((req) => s.portalService.attendance(req.principal, req.query)));
  me.get('/payslips', handle((req) => s.portalService.payslips(req.principal)));
  me.get('/payslips/:id', handle((req) => s.portalService.payslip(req.principal, req.params.id)));
  me.get('/payslips/:id/proof', sendFile((req) => s.paymentService.proof(req.orgId, req.params.id, { ownerStaffId: req.principal.staffId })));
  me.get('/advances', handle((req) => s.portalService.advances(req.principal)));
  me.get('/leaves', handle((req) => s.portalService.leaves(req.principal)));
  me.post('/leaves', handle((req) => s.portalService.applyLeave(req.principal, req.body), created));
  me.delete('/leaves/:id', handle((req) => s.portalService.cancelLeave(req.principal, req.params.id)));
  me.get('/requests', handle((req) => s.portalService.requests(req.principal)));
  me.post('/requests', handle((req) => s.portalService.createRequest(req.principal, req.body), created));
  me.post('/requests/:id/cancel', handle((req) => s.portalService.cancelRequest(req.principal, req.params.id)));
  api.use('/me', me);

  // ---- Office (owner / admin) ----------------------------------------------
  const office = express.Router();
  office.use(requireRole('owner', 'admin'));
  const org = (req) => req.orgId;

  office.get('/org', handle((req) => s.orgService.get(org(req))));
  office.put('/org', handle((req) => s.orgService.update(org(req), req.body)));
  office.get('/dashboard', handle((req) => s.dashboardService.get(org(req))));

  office.get('/staff', handle((req) => s.staffService.list(org(req), req.query)));
  office.post('/staff', handle((req) => s.staffService.create(org(req), req.body), created));
  office.get('/staff/:id', handle((req) => s.staffService.get(org(req), req.params.id)));
  office.put('/staff/:id', handle((req) => s.staffService.update(org(req), req.params.id, req.body)));
  office.delete('/staff/:id', handle((req) => s.staffService.remove(org(req), req.params.id)));
  office.post('/staff/:id/access', handle((req) => s.staffService.grantAccess(org(req), req.params.id, req.body)));
  office.delete('/staff/:id/access', handle((req) => s.staffService.revokeAccess(org(req), req.params.id)));

  office.get('/sites', handle((req) => s.siteService.list(org(req))));
  office.post('/sites', handle((req) => s.siteService.create(org(req), req.body), created));
  office.get('/sites/:id', handle((req) => s.siteService.get(org(req), req.params.id)));
  office.put('/sites/:id', handle((req) => s.siteService.update(org(req), req.params.id, req.body)));
  office.delete('/sites/:id', handle((req) => s.siteService.remove(org(req), req.params.id)));
  office.get('/sites/:id/progress', handle((req) => s.siteService.progress(org(req), req.params.id)));
  office.get('/sites/:id/finance', handle((req) => s.siteService.finance(org(req), req.params.id)));
  office.get('/sites/:id/staff', handle((req) => s.siteService.staff(org(req), req.params.id)));
  office.post('/sites/:id/assign', handle((req) => s.siteService.assign(org(req), req.params.id, req.body), created));
  office.delete('/sites/:id/assign/:staffId', handle((req) => s.siteService.unassign(org(req), req.params.id, req.params.staffId)));

  office.get('/attendance', handle((req) => s.attendanceService.siteDay(org(req), req.query.siteId, req.query.date)));
  office.post('/attendance', handle((req) => s.attendanceService.markOne(org(req), req.body), created));
  office.post('/attendance/bulk', handle((req) => s.attendanceService.bulk(org(req), req.body), created));
  office.get('/attendance/staff/:staffId', handle((req) => s.attendanceService.staffHistory(org(req), req.params.staffId, req.query)));

  office.get('/payments', handle((req) => s.paymentService.list(org(req), req.query)));
  office.get('/payments/preview', handle((req) => s.paymentService.preview(org(req), req.query)));
  office.get('/payments/outstanding', handle((req) => s.paymentService.outstanding(org(req), req.query)));
  office.post('/payments', handle((req) => s.paymentService.create(org(req), req.body), created));
  office.get('/payments/:id', handle((req) => s.paymentService.slip(org(req), req.params.id)));
  office.get('/payments/:id/proof', sendFile((req) => s.paymentService.proof(org(req), req.params.id)));
  office.put('/payments/:id/mark-paid', handle((req) => s.paymentService.markPaid(org(req), req.params.id, req.body)));
  office.delete('/payments/:id', handle((req) => s.paymentService.cancel(org(req), req.params.id)));

  office.get('/payroll', handle((req) => s.payrollService.list(org(req))));
  office.get('/payroll/preview', handle((req) => s.payrollService.preview(org(req), req.query)));
  office.post('/payroll', handle((req) => s.payrollService.create(org(req), req.body), created));
  office.get('/payroll/:id', handle((req) => s.payrollService.get(org(req), req.params.id)));
  office.put('/payroll/:id/mark-paid', handle((req) => s.payrollService.markPaid(org(req), req.params.id, req.body)));
  office.delete('/payroll/:id', handle((req) => s.payrollService.cancel(org(req), req.params.id)));

  office.get('/advances', handle((req) => s.advanceService.list(org(req), req.query)));
  office.get('/advances/balances', handle((req) => s.advanceService.balances(org(req))));
  office.post('/advances', handle((req) => s.advanceService.create(org(req), req.body), created));
  office.delete('/advances/:id', handle((req) => s.advanceService.remove(org(req), req.params.id)));

  office.get('/expenses', handle((req) => s.siteMoneyService.expenses.list(org(req), req.query)));
  office.post('/expenses', handle((req) => s.siteMoneyService.expenses.create(org(req), req.body), created));
  office.put('/expenses/:id', handle((req) => s.siteMoneyService.expenses.update(org(req), req.params.id, req.body)));
  office.delete('/expenses/:id', handle((req) => s.siteMoneyService.expenses.remove(org(req), req.params.id)));

  office.get('/receipts', handle((req) => s.siteMoneyService.receipts.list(org(req), req.query)));
  office.post('/receipts', handle((req) => s.siteMoneyService.receipts.create(org(req), req.body), created));
  office.delete('/receipts/:id', handle((req) => s.siteMoneyService.receipts.remove(org(req), req.params.id)));

  office.get('/leaves', handle((req) => s.leaveService.list(org(req), req.query)));
  office.post('/leaves', handle((req) => s.leaveService.create(org(req), req.body), created));
  office.put('/leaves/:id', handle((req) => s.leaveService.update(org(req), req.params.id, req.body)));
  office.delete('/leaves/:id', handle((req) => s.leaveService.remove(org(req), req.params.id)));

  office.get('/requests', handle((req) => s.requestService.list(org(req), req.query)));
  office.put('/requests/:id', handle((req) => s.requestService.decide(org(req), req.params.id, req.body)));

  office.get('/performance', handle((req) => s.performanceService.list(org(req), req.query)));
  office.post('/performance', handle((req) => s.performanceService.save(org(req), req.body), created));
  office.delete('/performance/:id', handle((req) => s.performanceService.remove(org(req), req.params.id)));

  office.get('/reports/summary', handle((req) => s.reportService.summary(org(req), req.query)));
  office.get('/reports/muster', handle((req) => s.reportService.muster(org(req), req.query)));

  api.use(office);
  return api;
};
