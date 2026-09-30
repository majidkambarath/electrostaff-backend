// End-to-end API test: runs the full business cycle against an in-memory MongoDB.
// Usage: npm test (from backend/). Never touches the database in .env.
const { MongoMemoryServer } = require('mongodb-memory-server');


let failures = 0;
const check = (cond, label, extra) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
};

const iso = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('electrostaff_test');
  process.env.DEFAULT_ORGANIZATION_ID = ''; // set (not deleted) so dotenv can't fill it from .env

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const { buildApp } = require('../server');
  const { buildConfig } = require('../src/config');
  const app = buildApp({ ...buildConfig(), authRateLimit: 1000, rateLimitPerMinute: 10000 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let adminToken = '';

  const call = async (method, url, body, token = adminToken) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, type: res.headers.get('content-type') };
  };

  try {
    console.log('Auth & setup');
    let r = await call('GET', '/auth/status');
    check(r.data.setupRequired === true, 'fresh install needs setup');
    r = await call('GET', '/staff');
    check(r.status === 401, 'data routes need sign-in');
    r = await call('POST', '/auth/setup', { name: 'Owner', phone: '98450 11111', password: 'short' });
    check(r.status === 400, 'weak password rejected at setup');
    r = await call('POST', '/auth/setup', { name: 'Owner', phone: '98450 11111', password: 'owner-pass-1', businessName: 'Test Electricals' });
    check(r.status === 201 && r.data.token && r.data.principal.role === 'owner', 'owner created by setup', r.data);
    adminToken = r.data.token;
    r = await call('POST', '/auth/setup', { name: 'X', phone: '9845022222', password: 'another-pass' });
    check(r.status === 409, 'setup cannot run twice');
    r = await call('POST', '/auth/login', { phone: '9845011111', password: 'wrong-pass' }, '');
    check(r.status === 401, 'wrong password -> 401');
    r = await call('POST', '/auth/login', { phone: { $gt: '' }, password: { $gt: '' } }, '');
    check(r.status === 400, 'NoSQL operator injection in login is neutralised');
    r = await call('POST', '/auth/login', { phone: '+91 98450-11111', password: 'owner-pass-1' }, '');
    check(r.status === 200 && r.data.principal.role === 'owner', 'owner signs in with formatted phone');
    adminToken = r.data.token;
    r = await call('GET', '/auth/me');
    check(r.data.principal.name === 'Owner' && r.data.organization.name === 'Test Electricals', '/auth/me returns owner + business');
    r = await call('GET', '/staff', null, 'not-a-token');
    check(r.status === 401, 'bad token rejected');
    r = await call('PUT', '/org', { name: 'Test Electricals', phone: '999' });
    check(r.data.name === 'Test Electricals', 'PUT /org updates business');

    console.log('Staff');
    r = await call('POST', '/staff', { name: 'Arun', phone: '9000000001', dailyWage: 800, role: 'electrician', joinDate: iso(-30) });
    check(r.status === 201, 'create staff A', r.data);
    const A = r.data._id;
    r = await call('POST', '/staff', { name: 'Bala', phone: '9000000002', dailyWage: 555, role: 'helper', joinDate: iso(-30) });
    const B = r.data._id;
    r = await call('POST', '/staff', { name: 'Dup', phone: '9000000001', dailyWage: 500 });
    check(r.status === 409, 'duplicate phone rejected', r.data);
    r = await call('POST', '/staff', { name: 'NoWage', phone: '9000000009' });
    check(r.status === 400, 'missing wage -> 400 validation', r.data);
    r = await call('GET', '/staff/not-an-id');
    check(r.status === 400, 'invalid id -> 400 (not 500)', r.data);
    r = await call('GET', '/staff?q=aru');
    check(r.data.length === 1 && r.data[0].name === 'Arun', 'staff search by name');

    console.log('Sites & assignment');
    r = await call('POST', '/sites', { name: 'Mall Wiring', clientName: 'ABC', startDate: iso(-10) });
    check(r.status === 201, 'create site 1');
    const S1 = r.data._id;
    r = await call('POST', '/sites', { name: 'Villa', startDate: iso(-10) });
    const S2 = r.data._id;
    r = await call('POST', `/sites/${S1}/assign`, { staffIds: [A, B] });
    check(r.status === 201 && r.data.length === 2, 'bulk assign A,B to site 1', r.data);
    r = await call('POST', `/sites/${S2}/assign`, { staffId: A });
    check(r.status === 201, 'assign A to site 2');
    r = await call('GET', '/sites');
    check(r.data.find((s) => s._id === S1).staffCount === 2, 'site list has aggregated staff count');

    console.log('Attendance');
    r = await call('POST', '/attendance/bulk', {
      siteId: S1,
      date: iso(-3),
      records: [{ staffId: A, status: 'present' }, { staffId: B, status: 'half' }],
    });
    check(r.status === 201 && r.data.saved === 2, 'bulk mark day -3', r.data);
    for (const off of [-2, -1]) {
      await call('POST', '/attendance/bulk', { siteId: S1, date: iso(off), records: [{ staffId: A, status: 'present' }, { staffId: B, status: 'present' }] });
    }
    r = await call('POST', '/attendance/bulk', { siteId: S2, date: iso(-1), records: [{ staffId: A, status: 'present' }] });
    check(r.data.saved === 0 && /Already worked/.test(r.data.skipped[0]?.reason), 'double full day across sites blocked', r.data);
    r = await call('POST', '/attendance/bulk', { siteId: S2, date: iso(0), records: [{ staffId: A, status: 'half' }] });
    await call('POST', '/attendance/bulk', { siteId: S1, date: iso(0), records: [{ staffId: A, status: 'half' }] });
    r = await call('GET', `/attendance?siteId=${S1}&date=${iso(0)}`);
    const aToday = r.data.records.find((x) => x.staff._id === A);
    check(aToday.attendance?.status === 'half' && aToday.elsewhere.length === 1, 'half+half across sites allowed, elsewhere reported', aToday);
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(1), records: [{ staffId: A, status: 'present' }] });
    check(r.status === 400, 'future date rejected', r.data);
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-4), records: [{ staffId: A, status: 'weird' }] });
    check(r.status === 400, 'invalid status rejected');
    await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-4), records: [{ staffId: B, status: 'absent' }] });
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-4), records: [{ staffId: B, status: '' }] });
    r = await call('GET', `/attendance?siteId=${S1}&date=${iso(-4)}`);
    check(!r.data.records.find((x) => x.staff._id === B).attendance, 'empty status clears a mark');

    console.log('Leaves');
    r = await call('POST', '/leaves', { staff: B, startDate: iso(-5), endDate: iso(-5), type: 'sick' });
    check(r.status === 201 && r.data.days === 1, 'create leave');
    const L = r.data._id;
    r = await call('POST', '/leaves', { staff: B, startDate: iso(-5), endDate: iso(-6) });
    check(r.status === 400, 'leave end before start rejected');
    await call('PUT', `/leaves/${L}`, { status: 'approved' });
    r = await call('GET', `/attendance?siteId=${S1}&date=${iso(-5)}`);
    check(r.data.records.find((x) => x.staff._id === B).leaveType === 'sick', 'approved leave surfaces in attendance');

    console.log('Payments & advances');
    r = await call('GET', '/payments/outstanding');
    const outA = r.data.find((o) => o.staff._id === A);
    // A: 3 present @ S1 + half @ S1 + half @ S2 = 800*3.5? per-site rounding: S1 3.5 days=2800, S2 0.5=400
    check(outA && outA.amount === 3200, 'outstanding wages for A = 3200', outA);
    r = await call('POST', '/advances', { staffId: A, amount: 1000, date: iso(-2) });
    check(r.status === 201, 'give advance 1000 to A');
    const ADV = r.data._id;
    r = await call('GET', `/payments/preview?staffId=${A}&periodStart=${iso(-3)}&periodEnd=${iso(0)}`);
    check(r.data.totalAmount === 3200 && r.data.advanceBalance === 1000 && r.data.breakdown.length === 2, 'preview A', r.data);
    r = await call('POST', '/payments', { staffId: A, periodStart: iso(-3), periodEnd: iso(0), advanceDeducted: 1500 });
    check(r.status === 400, 'advance recovery above balance rejected', r.data);
    r = await call('POST', '/payments', { staffId: A, periodStart: iso(-3), periodEnd: iso(0), advanceDeducted: 600, bonus: 100, deductions: 50 });
    check(r.status === 201 && r.data.netAmount === 2650 && r.data.status === 'pending', 'pending payment net = 3200+100-50-600', r.data);
    const PA = r.data._id;
    r = await call('POST', '/payments', { staffId: A, periodStart: iso(-1), periodEnd: iso(0) });
    check(r.status === 409, 'overlapping payment blocked', r.data);
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-2), records: [{ staffId: A, status: 'absent' }] });
    check(r.data.saved === 0 && /pending payment/.test(r.data.skipped[0]?.reason), 'attendance locked inside payment period', r.data);
    r = await call('DELETE', `/advances/${ADV}`);
    check(r.status === 400, 'recovered advance cannot be deleted');
    r = await call('PUT', `/payments/${PA}/mark-paid`, { paymentMode: 'upi' });
    check(r.data.status === 'paid' && r.data.paymentMode === 'upi', 'mark paid');
    r = await call('DELETE', `/payments/${PA}`);
    check(r.status === 400, 'paid payment cannot be cancelled');
    r = await call('POST', '/payments', { staffId: B, periodStart: iso(-3), periodEnd: iso(-1), markPaid: true });
    check(r.status === 400, 'one-step pay requires payment mode');
    r = await call('POST', '/payments', { staffId: B, periodStart: iso(-3), periodEnd: iso(-1) });
    check(r.status === 201 && r.data.totalAmount === Math.round(555 * 2.5), 'B pending payment = 555*2.5 rounded', r.data);
    const PB = r.data._id;
    r = await call('DELETE', `/payments/${PB}`);
    check(r.status === 200, 'cancel pending payment');
    r = await call('POST', '/payments', { staffId: B, periodStart: iso(-3), periodEnd: iso(-1), markPaid: true, paymentMode: 'cash' });
    check(r.data.status === 'paid', 'one-step create & pay');
    r = await call('GET', '/payments/outstanding');
    check(r.data.length === 0, 'nothing outstanding after paying both', r.data);
    r = await call('GET', `/payments/${PA}`);
    check(r.data.organization?.name === 'Test Electricals' && r.data.breakdown[0].siteId.name, 'slip includes org + site names');
    r = await call('GET', '/advances/balances');
    check(r.data[0].balance === 400, 'advance balance 1000-600 = 400', r.data);

    console.log('Performance, dashboard, reports, progress');
    const now = new Date();
    r = await call('POST', '/performance', { staff: A, month: now.getMonth() + 1, year: now.getFullYear(), rating: 5, tasksCompleted: 12 });
    check(r.status === 201, 'save rating');
    r = await call('GET', `/performance?month=${now.getMonth() + 1}&year=${now.getFullYear()}`);
    check(r.data[0].attendance && r.data[0].attendance.marked >= 1, 'rating includes month attendance', r.data[0]);
    r = await call('GET', '/dashboard');
    check(r.status === 200 && r.data.charts.attendanceTrend.length === 14 && r.data.charts.wagesTrend.length === 6, 'dashboard shape', r.data?.stats);
    check(r.data.stats.outstandingAmount === 0 && r.data.stats.advanceOutstanding === 400, 'dashboard money stats', r.data.stats);
    r = await call('GET', `/reports/summary?from=${iso(-10)}&to=${iso(0)}`);
    check(r.status === 200 && r.data.totals.earned === 3200 + 1388, 'report earned totals', r.data?.totals);
    check(r.data.bySite.length === 2, 'report by site');
    r = await call('GET', `/sites/${S1}/progress`);
    check(r.status === 200 && r.data.summary.labourCost > 0 && r.data.trend.length === 14, 'site progress with labour cost', r.data?.summary);

    console.log('Overtime');
    r = await call('POST', '/staff', { name: 'Chandru', phone: '9000000011', dailyWage: 800 });
    const C = r.data._id;
    r = await call('POST', '/staff', { name: 'Dinesh', phone: '9000000012', dailyWage: 600, otRate: 150 });
    const D = r.data._id;
    await call('POST', `/sites/${S1}/assign`, { staffIds: [C, D] });
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-2), records: [{ staffId: C, status: 'present', otHours: 2 }] });
    check(r.data.saved === 1, 'present with 2h OT saved', r.data);
    await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-1), records: [{ staffId: C, status: 'half', otHours: 1 }, { staffId: D, status: 'present', otHours: 2 }] });
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-3), records: [{ staffId: D, status: 'absent', otHours: 3 }] });
    r = await call('GET', `/attendance?siteId=${S1}&date=${iso(-3)}`);
    check(r.data.records.find((x) => x.staff._id === D).attendance.otHours === 0, 'OT ignored on absent days');
    r = await call('POST', '/attendance/bulk', { siteId: S1, date: iso(-2), records: [{ staffId: D, status: 'present', otHours: 20 }] });
    check(r.status === 400, 'OT above 16h rejected');
    r = await call('GET', `/payments/preview?staffId=${C}&periodStart=${iso(-3)}&periodEnd=${iso(0)}`);
    // default OT rate = 800/8 = 100/h: (800 + 200) + (400 + 100)
    check(r.data.totalAmount === 1500 && r.data.otHours === 3 && r.data.otAmount === 300, 'OT paid at default rate (wage/8)', r.data);
    r = await call('GET', `/payments/preview?staffId=${D}&periodStart=${iso(-3)}&periodEnd=${iso(0)}`);
    check(r.data.totalAmount === 900, 'OT paid at custom rate (600 + 2×150)', r.data);

    console.log('Payroll run');
    r = await call('GET', `/payroll/preview?from=${iso(-3)}&to=${iso(0)}`);
    const pc = r.data.rows.find((x) => x.staff._id === C);
    check(pc && pc.totalAmount === 1500 && !pc.overlap, 'payroll preview lists C', pc);
    check(r.data.rows.find((x) => x.staff._id === A)?.overlap?.status === 'paid', 'payroll preview flags already-paid staff');
    r = await call('POST', '/payroll', { periodStart: iso(-3), periodEnd: iso(0), entries: [{ staffId: A }] });
    check(r.status === 400, 'payroll with only overlapping staff creates nothing', r.data);
    r = await call('POST', '/payroll', { periodStart: iso(-3), periodEnd: iso(0), entries: [{ staffId: C }, { staffId: D, bonus: 100 }, { staffId: A }] });
    check(r.status === 201 && r.data.created === 2 && r.data.skipped.length === 1 && r.data.totalNet === 2500, 'payroll creates 2, skips 1', r.data);
    const RUN = r.data.run._id;
    r = await call('GET', '/payroll');
    check(r.data[0].count === 2 && r.data[0].pending === 2, 'payroll run listed with totals', r.data[0]);
    r = await call('PUT', `/payroll/${RUN}/mark-paid`, { paymentMode: 'cash' });
    check(r.data.updated === 2, 'mark whole payroll paid');
    r = await call('GET', `/payroll/${RUN}`);
    check(r.data.payments.every((p) => p.status === 'paid') && r.data.organization, 'payroll sheet data');
    r = await call('DELETE', `/payroll/${RUN}`);
    check(r.status === 400, 'paid payroll cannot be cancelled');

    console.log('Site finance');
    await call('PUT', `/sites/${S1}`, { contractValue: 50000 });
    r = await call('POST', '/receipts', { siteId: S1, amount: 20000, date: iso(-2), reference: 'RA bill 1' });
    check(r.status === 201, 'client payment recorded');
    r = await call('POST', '/expenses', { siteId: S1, category: 'material', amount: 3000, date: iso(-1), vendor: 'Anchor' });
    check(r.status === 201, 'site expense recorded');
    r = await call('POST', '/expenses', { category: 'rent', amount: 500, date: iso(-1) });
    check(r.status === 201 && !r.data.siteId, 'general expense recorded');
    r = await call('POST', '/expenses', { siteId: S1, amount: 0, date: iso(-1) });
    check(r.status === 400, 'zero expense rejected');
    r = await call('GET', `/sites/${S1}/finance`);
    const fin = r.data.summary;
    check(fin.received === 20000 && fin.due === 30000 && fin.expenses === 3000 && fin.profit === 50000 - fin.labourCost - 3000, 'site finance summary', fin);
    check(r.data.costBreakdown.some((c) => c.category === 'labour') && r.data.costBreakdown.some((c) => c.category === 'material'), 'cost breakdown has labour + material');
    r = await call('GET', '/sites');
    check(r.data.find((s) => s._id === S1).finance.due === 30000, 'site list carries finance');
    r = await call('GET', `/expenses?siteId=general`);
    check(r.data.length === 1 && r.data[0].category === 'rent', 'filter general expenses');
    r = await call('GET', `/reports/summary?from=${iso(-10)}&to=${iso(0)}`);
    check(r.data.totals.expenses === 3500 && r.data.totals.received === 20000 && r.data.totals.otHours === 5, 'report money + OT totals', r.data.totals);
    r = await call('GET', '/dashboard');
    check(r.data.stats.clientDues === 30000 && r.data.charts.siteCost[0].expenses === 3000, 'dashboard dues + site cost split', r.data.stats);

    console.log('Muster roll & slip');
    const md = new Date();
    md.setDate(md.getDate() - 2);
    r = await call('GET', `/reports/muster?month=${md.getMonth() + 1}&year=${md.getFullYear()}&siteId=${S1}`);
    const cRow = r.data.rows.find((x) => x.staff._id === C);
    check(cRow && cRow.days[String(md.getDate())]?.[0]?.otHours === 2 && cRow.totals.otHours === 3, 'muster row has day cells + OT totals', cRow);
    r = await call('GET', '/reports/muster?month=13&year=2026');
    check(r.status === 400, 'muster validates month');
    r = await call('GET', `/payments/${PA}`);
    check(r.data.attendance && r.data.attendance.present >= 3, 'slip includes period attendance summary', r.data.attendance);

    console.log('Staff app: access, sign-in, check-in');
    r = await call('POST', `/staff/${B}/access`, { password: '123' });
    check(r.status === 400, 'too-short staff password rejected');
    r = await call('POST', `/staff/${B}/access`, { generate: true });
    check(r.status === 200 && r.data.password?.length === 8, 'office grants app access with generated password', r.data);
    const bPass = r.data.password;
    r = await call('POST', '/auth/login', { phone: '9000000002', password: bPass }, '');
    check(r.status === 200 && r.data.principal.role === 'staff' && r.data.principal.mustChangePassword, 'staff signs in (must change password)');
    let staffToken = r.data.token;
    r = await call('POST', '/auth/change-password', { currentPassword: bPass, newPassword: 'bala-new-pass' }, staffToken);
    check(r.status === 200 && r.data.token, 'staff changes password');
    const oldStaffToken = staffToken;
    staffToken = r.data.token;
    r = await call('GET', '/me/home', null, oldStaffToken);
    check(r.status === 401, 'old session is signed out after password change');
    r = await call('GET', '/staff', null, staffToken);
    check(r.status === 403, 'staff cannot open office routes');
    r = await call('GET', '/me/home', null, adminToken);
    check(r.status === 403, 'office cannot open staff-only routes');
    r = await call('GET', '/me/home', null, staffToken);
    check(r.status === 200 && r.data.staff.name === 'Bala' && r.data.sites.some((x) => x._id === S1), 'staff home shows own sites', r.data);
    r = await call('GET', '/notifications/unread-count');
    const unreadBefore = r.data.unread;
    r = await call('POST', '/me/check-in', { siteId: S1, status: 'present', lat: 13.08, lng: 80.27, accuracy: 12 }, staffToken);
    check(r.status === 201 && r.data.today.some((t) => t.source === 'staff' && t.checkIn?.lat === 13.08), 'staff checks in with location', r.data);
    r = await call('GET', `/attendance?siteId=${S1}&date=${iso(0)}`);
    check(r.data.records.find((x) => x.staff._id === B)?.attendance?.source === 'staff', 'office sees self check-in');
    r = await call('GET', '/notifications');
    check(r.data.unread === unreadBefore + 1 && /Bala checked in/.test(r.data.items[0].title), 'office notified of check-in', r.data.items?.[0]);
    r = await call('POST', '/me/check-in', { siteId: S2, status: 'present' }, staffToken);
    check(r.status === 400, 'cannot check in at a site you are not assigned to');
    r = await call('POST', '/me/check-in/undo', { siteId: S1 }, staffToken);
    check(r.status === 200 && r.data.today.length === 0, 'staff undoes own check-in');

    console.log('Staff app: leave & requests');
    r = await call('POST', '/me/leaves', { startDate: iso(2), endDate: iso(3), type: 'casual', reason: 'Wedding', status: 'approved' }, staffToken);
    check(r.status === 201 && r.data.status === 'pending' && r.data.source === 'staff', 'staff leave is always pending', r.data);
    const LV = r.data._id;
    r = await call('PUT', `/leaves/${LV}`, { status: 'approved', responseNote: 'Enjoy' });
    check(r.data.status === 'approved', 'office approves leave');
    r = await call('GET', '/notifications', null, staffToken);
    check(r.data.items.some((n) => /leave was approved/.test(n.title)), 'staff notified of leave decision');
    r = await call('DELETE', `/me/leaves/${LV}`, null, staffToken);
    check(r.status === 400, 'approved leave cannot be cancelled by staff');
    r = await call('POST', '/me/requests', { type: 'advance', amount: 700, note: 'School fees' }, staffToken);
    check(r.status === 201 && r.data.status === 'pending', 'staff requests an advance');
    const RQ = r.data._id;
    r = await call('PUT', `/requests/${RQ}`, { status: 'approved', paymentMode: 'upi' });
    check(r.status === 200 && r.data.advanceId, 'approval records the advance', r.data);
    r = await call('GET', '/me/advances', null, staffToken);
    check(r.data.balance === 700, 'staff sees advance balance');
    r = await call('PUT', `/requests/${RQ}`, { status: 'rejected' });
    check(r.status === 400, 'decided request cannot be decided again');
    await call('POST', '/notifications/read', {}, staffToken);
    r = await call('GET', '/notifications/unread-count', null, staffToken);
    check(r.data.unread === 0, 'mark all notifications read');

    console.log('UPI proof of payment');
    await call('PUT', `/staff/${B}`, { upiId: 'bala@okaxis' });
    r = await call('PUT', `/staff/${B}`, { upiId: 'not a upi' });
    check(r.status === 400, 'invalid UPI ID rejected');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    r = await call('POST', '/payments', { staffId: B, periodStart: iso(0), periodEnd: iso(0), markPaid: true, paymentMode: 'upi', proof: 'data:image/png;base64,AAAA' });
    check(r.status === 400, 'fake image rejected by content check');
    await call('POST', '/attendance/bulk', { siteId: S1, date: iso(0), records: [{ staffId: B, status: 'present' }] });
    r = await call('POST', '/payments', { staffId: B, periodStart: iso(0), periodEnd: iso(0), markPaid: true, paymentMode: 'upi', transactionRef: 'UTR123456', proof: png });
    check(r.status === 201 && r.data.transactionRef === 'UTR123456' && r.data.proofId, 'paid with UTR + screenshot', r.data);
    const PP = r.data._id;
    r = await call('GET', `/payments/${PP}/proof`);
    check(r.status === 200 && r.type === 'image/png', 'office downloads proof', { status: r.status, type: r.type, data: typeof r.data === 'string' ? r.data.slice(0, 80) : r.data });
    r = await call('GET', `/me/payslips/${PP}/proof`, null, staffToken);
    check(r.status === 200, 'staff sees proof of own payment');
    r = await call('GET', `/me/payslips/${PA}`, null, staffToken);
    check(r.status === 403, "staff cannot open someone else's payslip");

    console.log('Revoking access');
    r = await call('DELETE', `/staff/${B}/access`);
    check(r.status === 200, 'office turns off app access');
    r = await call('GET', '/me/home', null, staffToken);
    check(r.status === 401 || r.status === 403, 'revoked staff session stops working');
    r = await call('POST', '/auth/login', { phone: '9000000002', password: 'bala-new-pass' }, '');
    check(r.status === 401, 'revoked staff cannot sign in');

    console.log('Archive rules');
    r = await call('DELETE', `/staff/${A}`);
    check(r.data.archived === true, 'staff with history archived');
    r = await call('POST', '/staff', { name: 'Temp', phone: '9000000003', dailyWage: 400 });
    r = await call('DELETE', `/staff/${r.data._id}`);
    check(r.data.archived === false, 'staff without history deleted');
    r = await call('DELETE', `/sites/${S2}`);
    check(r.data.archived === true, 'site with attendance archived');
    r = await call('POST', `/sites/${S2}/assign`, { staffId: B });
    check(r.status === 400, 'cannot assign to completed site');
    r = await call('GET', '/nope');
    check(r.status === 404, 'unknown route -> 404 JSON');

    console.log('Password recovery (command line)');
    const { spawnSync } = require('child_process');
    const reset = (...args) =>
      spawnSync(process.execPath, [require('path').join(__dirname, '../scripts/reset-password.js'), ...args], {
        env: process.env,
        encoding: 'utf8',
      });
    let cli = reset('9000099999', 'whatever-1');
    check(cli.status !== 0, 'reset refuses an unknown number');
    cli = reset('98450 11111', 'owner-reset-1');
    check(cli.status === 0 && cli.stdout.includes('Password reset for Owner'), 'owner password reset from the CLI', cli.stderr);
    r = await call('GET', '/auth/me');
    check(r.status === 401, 'reset signs out existing sessions');
    r = await call('POST', '/auth/login', { phone: '9845011111', password: 'owner-reset-1' }, '');
    check(r.status === 200 && r.data.principal.role === 'owner', 'owner signs in with the new password');
    adminToken = r.data.token;
    r = await call('POST', '/staff', { name: 'Login Holder', phone: '9000000077', dailyWage: 500 });
    await call('POST', `/staff/${r.data._id}/access`, { generate: true });
    cli = reset('98450 11111', 'owner-reset-2', '9000000077');
    check(cli.status !== 0, 'cannot move owner onto a staff login number');
    cli = reset('98450 11111', 'owner-reset-2', '9845022222');
    check(cli.status === 0 && cli.stdout.includes('Sign in with 9845022222'), 'owner moved to a new mobile number', cli.stderr);
    r = await call('POST', '/auth/login', { phone: '9845011111', password: 'owner-reset-2' }, '');
    check(r.status === 401, 'old number no longer signs in');
    r = await call('POST', '/auth/login', { phone: '9845022222', password: 'owner-reset-2' }, '');
    check(r.status === 200 && r.data.principal.role === 'owner', 'owner signs in with the new number');
  } catch (err) {
    failures += 1;
    console.error('Test crashed:', err);
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
