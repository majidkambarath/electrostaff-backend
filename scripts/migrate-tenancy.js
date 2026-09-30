// One-time move from the single-business install to multi-tenant SaaS. Safe to run again.
//   npm run migrate:tenancy -- [--dry-run] [--name "Business name"]
// 1. Picks the existing business (the organization the office accounts belong to).
// 2. Optionally renames it, gives it a readable slug and status 'active'.
// 3. Attaches every record without an organizationId to it (nothing is deleted).
// 4. Checks that each login number is used by only one account on the platform.
// 5. Syncs the Staff indexes (unique staff-app login number).
require('dotenv').config();
const mongoose = require('mongoose');
const { buildConfig } = require('../src/config');
const { connectMongo } = require('../src/infrastructure/mongo/connection');
const models = require('../src/infrastructure/mongo/models');
const { slugify } = require('../src/domain/organizations');

const TENANT_MODELS = [
  'Staff', 'Site', 'SiteAssignment', 'Attendance', 'Payment', 'PayrollRun', 'Advance', 'Expense',
  'ClientReceipt', 'Leave', 'Performance', 'StaffRequest', 'Notification', 'PushSubscription', 'Attachment',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const nameAt = args.indexOf('--name');
const newName = nameAt >= 0 ? args[nameAt + 1] : null;

const log = (msg) => console.log(`${dryRun ? '[dry run] ' : ''}${msg}`);

const pickTarget = async () => {
  const { Organization, User } = models;
  const orgIds = await User.distinct('organizationId');
  if (orgIds.length > 1) throw new Error(`Office accounts belong to ${orgIds.length} organizations; already migrated? Nothing to pick.`);
  if (orgIds.length === 1) return Organization.findById(orgIds[0]);
  const orgs = await Organization.find().limit(2);
  if (orgs.length === 1) return orgs[0];
  throw new Error('Could not decide which organization owns the existing data.');
};

const run = async () => {
  const config = buildConfig();
  await connectMongo(config.mongoUri);
  const { Organization, User, Staff } = models;
  try {
    const org = await pickTarget();
    log(`Business: "${org.name}" (${org._id}), slug ${org.slug || '-'}, status ${org.status || '-'}`);

    const set = {};
    if (newName && newName.trim() && newName.trim() !== org.name) set.name = newName.trim();
    if (!org.status) set.status = 'active';
    if (!org.slug || org.slug === 'default') {
      const base = slugify(set.name || org.name);
      const taken = await Organization.exists({ slug: base, _id: { $ne: org._id } });
      set.slug = taken ? `${base}-${String(org._id).slice(-6)}` : base;
    }
    if (Object.keys(set).length) {
      log(`Update business: ${JSON.stringify(set)}`);
      if (!dryRun) await Organization.updateOne({ _id: org._id }, { $set: set });
    }

    for (const name of TENANT_MODELS) {
      const filter = { organizationId: null };
      const n = await models[name].countDocuments(filter);
      if (!n) continue;
      log(`${name}: ${n} record(s) without a business -> "${set.name || org.name}"`);
      if (!dryRun) await models[name].collection.updateMany(filter, { $set: { organizationId: org._id } });
    }

    const clashes = [];
    const logins = await Staff.aggregate([
      { $match: { portalEnabled: true, phoneKey: { $ne: null } } },
      { $group: { _id: '$phoneKey', n: { $sum: 1 }, names: { $push: '$name' } } },
    ]);
    for (const l of logins) {
      if (l.n > 1) clashes.push(`${l._id}: staff logins ${l.names.join(', ')}`);
      if (await User.exists({ phoneKey: l._id })) clashes.push(`${l._id}: staff login ${l.names.join(', ')} and an office account`);
    }
    if (clashes.length) {
      console.error('Login numbers used by more than one account (turn off staff-app access or change the number, then run again):');
      clashes.forEach((c) => console.error(`  ${c}`));
      process.exitCode = 1;
      return;
    }
    log('Login numbers: each is used by one account');

    if (dryRun) log('Would sync Staff indexes (unique staff-app login number)');
    else {
      const dropped = await Staff.syncIndexes();
      await models.Organization.syncIndexes();
      await models.PlatformAdmin.syncIndexes();
      log(`Indexes synced${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}`);
    }
    log('Done.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
