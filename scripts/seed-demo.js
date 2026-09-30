// Fills one business with realistic demo data to try reports and flows:
// 5 sites, 12 staff (some on several sites), ~6 weeks of attendance with OT, half days and leave,
// advances, paid + pending wages, a payroll run, expenses, client receipts, ratings and requests.
//   npm run seed:demo -- <owner-mobile> <owner-password>
// Signs in as that owner (so it can only touch their business) and goes through the same use
// cases as the app. Existing data is left alone; it refuses to add the demo sites twice.
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config');
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const { buildContainer } = require('../src/container');

// Deterministic "random" so every run produces the same story.
let seed = 20261001;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
today.setHours(0, 0, 0, 0);
const daysAgo = (n) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d;
};

const SITES = [
  { key: 'mall', name: 'Lulu Mall – Lighting Upgrade', clientName: 'Lulu Group', clientPhone: '9847000101', address: 'Edappally, Kochi', contractValue: 850000 },
  { key: 'villa', name: 'Villa 14, Kakkanad', clientName: 'Rajesh Menon', clientPhone: '9847000102', address: 'Kakkanad, Kochi', contractValue: 320000 },
  { key: 'hospital', name: 'Aster Hospital – Panel Room', clientName: 'Aster Medcity', clientPhone: '9847000103', address: 'Cheranalloor, Kochi', contractValue: 560000 },
  { key: 'school', name: 'Govt. School Solar, Aluva', clientName: 'Aluva Municipality', clientPhone: '9847000104', address: 'Aluva', contractValue: 240000 },
  { key: 'apartment', name: 'Skyline Apartments – Block B', clientName: 'Skyline Builders', clientPhone: '9847000105', address: 'Vyttila, Kochi', contractValue: 1200000 },
];

// sites: where they work. Several people split their week across sites.
const STAFF = [
  { key: 'suresh', name: 'Suresh Kumar', role: 'supervisor', dailyWage: 1400, otRate: 200, upiId: 'suresh.k@okaxis', sites: ['mall', 'hospital', 'apartment'] },
  { key: 'anil', name: 'Anil Varghese', role: 'electrician', dailyWage: 1100, upiId: 'anilv@oksbi', sites: ['mall', 'villa'], app: 'anil1234' },
  { key: 'biju', name: 'Biju Thomas', role: 'electrician', dailyWage: 1050, sites: ['hospital', 'apartment'] },
  { key: 'manoj', name: 'Manoj P', role: 'electrician', dailyWage: 1000, upiId: 'manojp@ybl', sites: ['villa', 'school'], app: 'manoj1234' },
  { key: 'shaji', name: 'Shaji Mathew', role: 'electrician', dailyWage: 1000, otRate: 150, sites: ['mall', 'apartment'] },
  { key: 'rahul', name: 'Rahul Das', role: 'helper', dailyWage: 700, sites: ['mall'] },
  { key: 'akhil', name: 'Akhil Raj', role: 'helper', dailyWage: 650, upiId: 'akhilraj@okicici', sites: ['villa'] },
  { key: 'vishnu', name: 'Vishnu S', role: 'apprentice', dailyWage: 500, sites: ['hospital'] },
  { key: 'arjun', name: 'Arjun Nair', role: 'helper', dailyWage: 700, sites: ['school'] },
  { key: 'jithin', name: 'Jithin George', role: 'electrician', dailyWage: 1050, upiId: 'jithin.g@okhdfcbank', sites: ['apartment'] },
  { key: 'sanal', name: 'Sanal K', role: 'helper', dailyWage: 680, sites: ['apartment'] },
  { key: 'ramesh', name: 'Ramesh Babu', role: 'apprentice', dailyWage: 480, sites: ['mall', 'hospital'] },
];

const HISTORY_DAYS = 44; // about six weeks back from today

const run = async () => {
  const [phone, password] = process.argv.slice(2);
  if (!phone || !password) {
    console.error('Usage: npm run seed:demo -- <owner-mobile> <owner-password>');
    process.exit(1);
  }
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  const c = buildContainer(config);
  try {
    const { principal } = await c.authService.login({ phone, password });
    if (principal.kind !== 'user') throw new Error('Sign in with an owner/admin mobile number');
    const org = principal.organizationId;
    const orgName = (await c.orgService.get(org)).name;
    const existing = new Set((await c.siteService.list(org)).map((s) => s.name));
    if (SITES.some((s) => existing.has(s.name))) throw new Error(`${orgName} already has the demo sites; not adding them twice.`);
    console.log(`Adding demo data to ${orgName}…`);

    // Sites and staff
    const sites = {};
    for (const s of SITES) {
      const { key, ...body } = s;
      sites[key] = await c.siteService.create(org, { ...body, startDate: iso(daysAgo(HISTORY_DAYS + 5)), status: 'active' });
    }
    const staff = {};
    for (const [i, s] of STAFF.entries()) {
      const { key, sites: _sites, app, ...body } = s;
      staff[key] = await c.staffService.create(org, {
        ...body,
        phone: `94471${String(20000 + i * 137).padStart(5, '0')}`,
        joinDate: iso(daysAgo(HISTORY_DAYS + 30 + i * 11)),
        status: 'active',
      });
    }
    for (const site of SITES) {
      const ids = STAFF.filter((s) => s.sites.includes(site.key)).map((s) => String(staff[s.key]._id));
      await c.siteService.assign(org, String(sites[site.key]._id), { staffIds: ids });
    }
    console.log(`  ${SITES.length} sites, ${STAFF.length} staff, assignments`);

    // Leave: an approved sick leave and a pending one in the future
    const leaveFor = { vishnu: [10, 11], arjun: [22, 22] };
    for (const [key, [from, to]] of Object.entries(leaveFor)) {
      const leave = await c.leaveService.create(org, { staff: String(staff[key]._id), startDate: iso(daysAgo(to)), endDate: iso(daysAgo(from)), type: 'sick', reason: 'Fever' });
      await c.leaveService.update(org, String(leave._id), { status: 'approved', responseNote: 'Get well soon' });
    }
    const future = new Date(today);
    future.setDate(future.getDate() + 5);
    await c.leaveService.create(org, { staff: String(staff.akhil._id), startDate: iso(future), endDate: iso(future), type: 'casual', reason: 'Family function', status: 'pending' });
    const onLeave = (key, n) => leaveFor[key] && n >= leaveFor[key][0] && n <= leaveFor[key][1];

    // Attendance: Monday–Saturday, one payable day per person (sometimes half + half at two sites)
    let marks = 0;
    for (let n = HISTORY_DAYS; n >= 0; n -= 1) {
      const day = daysAgo(n);
      if (day.getDay() === 0) continue;
      const bySite = {};
      const add = (siteKey, rec) => (bySite[siteKey] = bySite[siteKey] || []).push(rec);
      for (const s of STAFF) {
        const id = String(staff[s.key]._id);
        if (onLeave(s.key, n)) {
          add(s.sites[0], { staffId: id, status: 'leave' });
          continue;
        }
        if (n === 0 && rand() < 0.35) continue; // today: not everyone marked yet
        const r = rand();
        if (s.sites.length > 1 && r < 0.12) {
          const [a, b] = [...s.sites].sort(() => rand() - 0.5);
          add(a, { staffId: id, status: 'half' });
          add(b, { staffId: id, status: 'half' });
        } else if (r < 0.2) {
          add(pick(s.sites), { staffId: id, status: 'absent' });
        } else if (r < 0.26) {
          add(pick(s.sites), { staffId: id, status: 'half' });
        } else {
          const ot = rand() < 0.22 ? pick([1, 2, 2, 3, 4]) : 0;
          add(pick(s.sites), { staffId: id, status: 'present', otHours: ot });
        }
      }
      for (const [siteKey, records] of Object.entries(bySite)) {
        const { saved, skipped } = await c.attendanceService.bulk(org, { siteId: String(sites[siteKey]._id), date: iso(day), records });
        marks += saved;
        if (skipped.length) console.warn(`  skipped on ${iso(day)}:`, skipped.map((x) => x.reason || x).join('; '));
      }
    }
    console.log(`  ${marks} attendance marks`);

    // Advances (some recovered from wages below)
    const advances = [
      ['anil', 3000, 38], ['biju', 2000, 30], ['manoj', 5000, 25], ['rahul', 1000, 20], ['jithin', 4000, 12], ['sanal', 1500, 6], ['suresh', 6000, 3],
    ];
    for (const [key, amount, ago] of advances) {
      await c.advanceService.create(org, { staffId: String(staff[key]._id), amount, date: iso(daysAgo(ago)), paymentMode: pick(['cash', 'upi']), note: pick(['Medical', 'School fees', 'House rent', 'Festival']) });
    }
    console.log(`  ${advances.length} advances`);

    // Wages: first two weeks paid one by one, next two weeks through a paid payroll run,
    // a few pending payments for the latest week, the rest left unpaid (outstanding).
    const p1 = [daysAgo(HISTORY_DAYS), daysAgo(HISTORY_DAYS - 13)];
    const p2 = [daysAgo(HISTORY_DAYS - 14), daysAgo(HISTORY_DAYS - 27)];
    const p3 = [daysAgo(HISTORY_DAYS - 28), daysAgo(HISTORY_DAYS - 34)];
    const recover = { anil: 1500, biju: 1000, manoj: 2500 };
    let paid = 0;
    for (const s of STAFF) {
      const mode = pick(['cash', 'upi', 'upi', 'bank']);
      await c.paymentService.create(org, {
        staffId: String(staff[s.key]._id),
        periodStart: iso(p1[0]),
        periodEnd: iso(p1[1]),
        advanceDeducted: recover[s.key] || 0,
        bonus: s.key === 'suresh' ? 1000 : 0,
        markPaid: true,
        paymentMode: mode,
        paidDate: iso(daysAgo(HISTORY_DAYS - 15)),
        transactionRef: mode === 'upi' ? `UTR${Math.floor(100000000000 + rand() * 899999999999)}` : undefined,
      });
      paid += 1;
    }
    const run2 = await c.payrollService.create(org, {
      periodStart: iso(p2[0]),
      periodEnd: iso(p2[1]),
      entries: STAFF.map((s) => ({ staffId: String(staff[s.key]._id), ...(s.key === 'rahul' ? { advanceDeducted: 1000 } : {}), ...(s.key === 'shaji' ? { deductions: 200 } : {}) })),
      note: 'Fortnight payroll',
    });
    await c.payrollService.markPaid(org, String(run2._id || run2.run?._id || run2.id), { paymentMode: 'upi', paidDate: iso(daysAgo(HISTORY_DAYS - 29)) });
    const pendingFor = ['suresh', 'anil', 'jithin', 'biju'];
    for (const key of pendingFor) {
      await c.paymentService.create(org, { staffId: String(staff[key]._id), periodStart: iso(p3[0]), periodEnd: iso(p3[1]) });
    }
    console.log(`  ${paid} paid slips, 1 paid payroll run (${STAFF.length} slips), ${pendingFor.length} pending payments; the rest is unpaid`);

    // Site money: materials and transport per site, rent as a general expense, client receipts
    let expenses = 0;
    for (const site of SITES) {
      for (let k = 0; k < 4; k += 1) {
        await c.siteMoneyService.expenses.create(org, {
          siteId: String(sites[site.key]._id),
          category: pick(['material', 'material', 'transport', 'tools', 'food']),
          amount: Math.round((2000 + rand() * 38000) / 100) * 100,
          date: iso(daysAgo(Math.floor(rand() * HISTORY_DAYS))),
          vendor: pick(['Anchor Electricals', 'Havells Dealer', 'Finolex Depot', 'Local hardware', 'Auto rickshaw']),
          paymentMode: pick(['cash', 'upi', 'bank']),
        });
        expenses += 1;
      }
    }
    for (const ago of [40, 10]) {
      await c.siteMoneyService.expenses.create(org, { category: 'rent', amount: 12000, date: iso(daysAgo(ago)), description: 'Office / store room rent', paymentMode: 'bank' });
      expenses += 1;
    }
    const receipts = [['mall', 250000, 35], ['mall', 200000, 8], ['villa', 120000, 30], ['hospital', 180000, 20], ['school', 240000, 15], ['apartment', 300000, 25], ['apartment', 150000, 4]];
    for (const [key, amount, ago] of receipts) {
      await c.siteMoneyService.receipts.create(org, { siteId: String(sites[key]._id), amount, date: iso(daysAgo(ago)), paymentMode: pick(['bank', 'cheque', 'upi']), reference: `RA bill ${Math.ceil(rand() * 5)}` });
    }
    console.log(`  ${expenses} expenses, ${receipts.length} client receipts`);

    // Ratings for last month, staff app logins and requests from the app
    const last = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    for (const s of STAFF) {
      await c.performanceService.save(org, {
        staff: String(staff[s.key]._id),
        month: last.getMonth() + 1,
        year: last.getFullYear(),
        rating: pick([3, 4, 4, 5, 5]),
        punctuality: pick([3, 4, 5]),
        quality: pick([3, 4, 5]),
        tasksCompleted: 5 + Math.floor(rand() * 20),
      });
    }
    const logins = [];
    for (const s of STAFF.filter((x) => x.app)) {
      try {
        await c.staffService.grantAccess(org, String(staff[s.key]._id), { password: s.app });
        logins.push(`${s.name}: ${staff[s.key].phone} / ${s.app}`);
      } catch (err) {
        console.warn(`  app login for ${s.name} skipped: ${err.message}`);
      }
    }
    const asStaff = (key) => ({ staffId: String(staff[key]._id), name: staff[key].name, organizationId: org, role: 'staff' });
    await c.requestService.create(org, asStaff('manoj'), { type: 'advance', amount: 2000, note: 'Hospital bill' });
    await c.requestService.create(org, asStaff('anil'), { type: 'other', note: 'Need new safety gloves' });

    // A finished job: the school solar site is completed
    await c.siteService.update(org, String(sites.school._id), { status: 'completed', endDate: iso(daysAgo(2)) });

    console.log('  ratings, 2 staff requests, 1 completed site');
    if (logins.length) console.log(`Staff app logins (they must change the password on first sign-in):\n  ${logins.join('\n  ')}`);
    console.log('Done.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
