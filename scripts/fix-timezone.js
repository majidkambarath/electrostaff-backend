// One-time repair: day-dates saved by a server running on UTC (midnight UTC / 23:59:59.999 UTC)
// are moved to the same calendar day in the app time zone (Asia/Kolkata), which the app now uses
// everywhere. Real timestamps and dates already in IST are left alone, so it is safe to run again.
//   npm run fix:timezone -- [--dry-run]
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config'); // pins process.env.TZ
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const models = require('../src/infrastructure/mongo/models');

const FIELDS = {
  Attendance: ['date'],
  Payment: ['periodStart', 'periodEnd', 'paidDate'],
  PayrollRun: ['periodStart', 'periodEnd'],
  Advance: ['date'],
  Expense: ['date'],
  ClientReceipt: ['date'],
  Leave: ['startDate', 'endDate'],
  Organization: ['plan.validUntil'],
};

const dryRun = process.argv.includes('--dry-run');
const get = (doc, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);

// A UTC day boundary -> the same calendar day's boundary in the app zone.
const shifted = (d) => {
  const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const utcEnd = d.getUTCHours() === 23 && d.getUTCMinutes() === 59 && d.getUTCSeconds() === 59 && d.getUTCMilliseconds() === 999;
  if (!utcMidnight && !utcEnd) return null;
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (utcEnd) local.setHours(23, 59, 59, 999);
  return local.getTime() === d.getTime() ? null : local;
};

const run = async () => {
  const config = buildConfig();
  console.log(`${dryRun ? '[dry run] ' : ''}App time zone: ${process.env.TZ}`);
  await connectMongo(config.mongoUri);
  try {
    for (const [name, fields] of Object.entries(FIELDS)) {
      const collection = models[name].collection;
      const docs = await collection.find({}, { projection: Object.fromEntries(fields.map((f) => [f, 1])) }).toArray();
      let changed = 0;
      const failed = [];
      for (const doc of docs) {
        const set = {};
        for (const f of fields) {
          const v = get(doc, f);
          const next = v instanceof Date ? shifted(v) : null;
          if (next) set[f] = next;
        }
        if (!Object.keys(set).length) continue;
        changed += 1;
        if (dryRun) continue;
        try {
          await collection.updateOne({ _id: doc._id }, { $set: set });
        } catch (err) {
          failed.push(`${doc._id}: ${err.code === 11000 ? 'the same day already exists (duplicate)' : err.message}`);
        }
      }
      if (changed) console.log(`${dryRun ? '[dry run] ' : ''}${name}: ${changed} record(s) moved to IST days`);
      failed.forEach((f) => console.warn(`  ${name} ${f}`));
    }
    console.log('Done.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
