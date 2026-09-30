const { normalizePhone, assertPassword } = require('../../domain/credentials');
const { invalid, unauthorized, forbidden, tooMany, conflict } = require('../../domain/errors');
const { requireText } = require('../validation');
const { trialPlan, planStatus } = require('../../domain/plans');

const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const ORG_STATUS_TTL_MS = 60 * 1000;
const EXPIRED = 'Your session has expired. Please sign in again.';
const SUSPENDED = 'This business account is suspended. Contact ElectroStaff support.';

// Sign-in for every account kind, plus public "create your business" sign-up.
//   user     – office account (owner/admin) of one organization
//   staff    – worker with staff-app access in one organization
//   platform – developer/operator of the SaaS (developer mode); no organization, signs in
//              with a username through platformLogin only
// Tokens carry { sub, kind, v: tokenVersion }; bumping tokenVersion (password change,
// access revoked) signs every device out. A login mobile number is unique across the platform.
module.exports = ({ userRepo, staffRepo, platformAdminRepo, orgRepo, orgService, passwordHasher, tokenService, config = {}, clock = () => Date.now() }) => {
  const failures = new Map(); // phoneKey -> { count, since }
  const orgCache = new Map(); // orgId -> { status, plan, at }

  const checkRate = (key) => {
    const entry = failures.get(key);
    if (entry && clock() - entry.since < WINDOW_MS && entry.count >= MAX_FAILURES) {
      throw tooMany('Too many failed attempts. Please wait 15 minutes and try again.');
    }
  };
  const recordFailure = (key) => {
    const entry = failures.get(key);
    if (!entry || clock() - entry.since >= WINDOW_MS) failures.set(key, { count: 1, since: clock() });
    else entry.count += 1;
  };

  // Suspended organizations are locked out; cached briefly so each request doesn't re-read it.
  // Returns the org's plan status (an expired plan makes the office read-only).
  const assertOrgActive = async (orgId) => {
    const key = String(orgId);
    let entry = orgCache.get(key);
    if (!entry || clock() - entry.at > ORG_STATUS_TTL_MS) {
      const org = await orgRepo.findById(orgId);
      entry = { status: org ? org.status || 'active' : 'missing', plan: org?.plan, at: clock() };
      orgCache.set(key, entry);
    }
    if (entry.status === 'missing') throw unauthorized(EXPIRED);
    if (entry.status !== 'active') throw forbidden(SUSPENDED);
    return planStatus(entry.plan, new Date(clock()));
  };

  // One number = one login on the whole platform (office user or staff app).
  const assertLoginPhoneFree = async (phoneKey, { staffId, userId } = {}, message) => {
    const msg = message || 'This mobile number is already used to sign in to ElectroStaff. Use a different number.';
    const user = await userRepo.findByPhoneKeyWithSecret(phoneKey);
    if (user && String(user._id) !== String(userId)) throw conflict(msg);
    if (await staffRepo.loginTaken(phoneKey, staffId)) throw conflict(msg);
  };

  const userPrincipal = (u, plan) => ({
    kind: 'user',
    id: String(u._id),
    role: u.role,
    name: u.name,
    phone: u.phone,
    organizationId: String(u.organizationId),
    mustChangePassword: Boolean(u.mustChangePassword),
    ...(u.role === 'supervisor' && { siteIds: (u.siteIds || []).map(String) }),
    ...(plan?.expired && { readOnly: true }),
  });
  const staffPrincipal = (s) => ({
    kind: 'staff',
    id: String(s._id),
    staffId: String(s._id),
    role: 'staff',
    name: s.name,
    phone: s.phone,
    organizationId: String(s.organizationId),
    mustChangePassword: Boolean(s.mustChangePassword),
  });
  const platformPrincipal = (a) => ({
    kind: 'platform',
    id: String(a._id),
    role: 'platform',
    name: a.name,
    username: a.username,
    organizationId: null,
  });

  const issue = (kind, account) => tokenService.sign({ sub: String(account._id), kind, v: account.tokenVersion || 0 });
  const repoFor = (kind) => ({ user: userRepo, staff: staffRepo, platform: platformAdminRepo })[kind];

  // Creates an organization with its owner account. Used by public sign-up and the platform portal.
  const createBusiness = async ({ businessName, name, phone, password, email, address }) => {
    const ownerName = requireText(name, 'Owner name', { min: 2 });
    const key = normalizePhone(phone);
    if (key.length !== 10) throw invalid('Enter a valid 10-digit mobile number');
    assertPassword(password);
    await assertLoginPhoneFree(key, {}, 'This mobile number is already registered. Sign in instead, or use another number.');
    const org = await orgService.create({ name: businessName, ownerName, phone, email, address }, { plan: trialPlan(new Date(clock())) });
    try {
      const user = await userRepo.create({
        name: ownerName,
        phone,
        passwordHash: await passwordHasher.hash(password),
        role: 'owner',
        organizationId: org._id,
      });
      return { org, user };
    } catch (err) {
      await orgService.remove(org._id); // no orphan business without an owner
      throw err;
    }
  };

  return {
    assertLoginPhoneFree,
    createBusiness,
    // Called after the platform portal changes an organization's status.
    forgetOrgStatus: (orgId) => orgCache.delete(String(orgId)),

    status: async () => ({ signupEnabled: config.signupEnabled !== false }),

    // Public: a new business signs up and gets its own organization.
    signup: async (input = {}) => {
      if (config.signupEnabled === false) throw forbidden('New sign-ups are closed. Contact ElectroStaff support.');
      const { user } = await createBusiness({
        businessName: input.businessName,
        name: input.name,
        phone: input.phone,
        password: input.password,
      });
      return { token: issue('user', user), principal: userPrincipal(user) };
    },

    // One sign-in screen for businesses: office accounts, then staff with app access.
    login: async ({ phone, password }) => {
      const key = normalizePhone(phone);
      if (key.length !== 10 || !password) throw invalid('Enter your mobile number and password');
      checkRate(key);

      const user = await userRepo.findByPhoneKeyWithSecret(key);
      if (user && (await passwordHasher.verify(password, user.passwordHash))) {
        const plan = await assertOrgActive(user.organizationId);
        failures.delete(key);
        userRepo.touchLogin(user._id);
        return { token: issue('user', user), principal: userPrincipal(user, plan) };
      }
      for (const staff of await staffRepo.findForLogin(key)) {
        if (await passwordHasher.verify(password, staff.passwordHash)) {
          await assertOrgActive(staff.organizationId);
          failures.delete(key);
          staffRepo.touchLogin(staff._id);
          return { token: issue('staff', staff), principal: staffPrincipal(staff) };
        }
      }
      recordFailure(key);
      throw unauthorized('Wrong mobile number or password');
    },

    // Resolves a bearer token to the signed-in principal, or throws.
    authenticate: async (token) => {
      const claims = token && tokenService.verify(token);
      if (!claims) throw unauthorized(EXPIRED);
      if (claims.kind === 'user') {
        const user = await userRepo.findById(claims.sub);
        if (!user || (user.tokenVersion || 0) !== claims.v) throw unauthorized(EXPIRED);
        return userPrincipal(user, await assertOrgActive(user.organizationId));
      }
      if (claims.kind === 'staff') {
        const staff = await staffRepo.findAuthById(claims.sub);
        if (!staff || (staff.tokenVersion || 0) !== claims.v) throw unauthorized(EXPIRED);
        if (!staff.portalEnabled || staff.status === 'inactive') throw forbidden('Your app access has been turned off. Contact the office.');
        await assertOrgActive(staff.organizationId);
        return staffPrincipal(staff);
      }
      if (claims.kind === 'platform') {
        const admin = await platformAdminRepo.findById(claims.sub);
        if (!admin || (admin.tokenVersion || 0) !== claims.v) throw unauthorized(EXPIRED);
        return platformPrincipal(admin);
      }
      throw unauthorized();
    },

    // Changing the password signs out other devices and returns a fresh token for this one.
    changePassword: async (principal, { currentPassword, newPassword }) => {
      assertPassword(newPassword);
      const repo = repoFor(principal.kind);
      const account = await repo.findByIdWithSecret(principal.id);
      if (!account || !(await passwordHasher.verify(currentPassword || '', account.passwordHash))) {
        throw invalid('Current password is wrong');
      }
      if (currentPassword === newPassword) throw invalid('Choose a new password different from the current one');
      const updated = await repo.setPassword(principal.id, await passwordHasher.hash(newPassword));
      return { token: issue(principal.kind, updated), message: 'Password changed' };
    },

    // Recovery for a forgotten office password. Only reachable from the server's command line
    // (scripts/reset-password.js), never over HTTP. Signs the account out everywhere.
    // Optionally moves the account to a new mobile number (its sign-in ID).
    resetOfficePassword: async (phone, newPassword, newPhone) => {
      const key = normalizePhone(phone);
      assertPassword(newPassword);
      const user = await userRepo.findByPhoneKeyWithSecret(key);
      if (!user) throw invalid(`No owner/admin account uses the mobile number ${phone}`);
      let phoneNow = user.phone;
      if (newPhone) {
        const newKey = normalizePhone(newPhone);
        if (newKey.length !== 10) throw invalid('Enter a valid 10-digit new mobile number');
        if (newKey !== key) {
          await assertLoginPhoneFree(newKey, { userId: user._id }, `${newPhone} is already used to sign in; pick another number`);
          await userRepo.setPhone(user._id, newKey);
          phoneNow = newKey;
        }
      }
      await userRepo.setPassword(user._id, await passwordHasher.hash(newPassword));
      failures.delete(key);
      return { name: user.name, role: user.role, phone: phoneNow };
    },

    // Developer mode sign-in (hidden on the sign-in screen): username + password.
    platformLogin: async ({ username, password }) => {
      const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
      if (!name || typeof password !== 'string' || !password) throw invalid('Enter the developer username and password');
      const key = `dev:${name}`;
      checkRate(key);
      const admin = await platformAdminRepo.findByUsernameWithSecret(name);
      if (admin && (await passwordHasher.verify(password, admin.passwordHash))) {
        failures.delete(key);
        platformAdminRepo.touchLogin(admin._id);
        return { token: issue('platform', admin), principal: platformPrincipal(admin) };
      }
      recordFailure(key);
      throw unauthorized('Wrong developer username or password');
    },

    // Command line only (scripts/platform-admin.js): creates a developer account or resets its password.
    upsertPlatformAdmin: async ({ username, password, name }) => {
      const handle = String(username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(handle)) throw invalid('Username: 3–32 letters, numbers, dot, dash or underscore');
      assertPassword(password);
      const hash = await passwordHasher.hash(password);
      const existing = await platformAdminRepo.findByUsernameWithSecret(handle);
      if (existing) {
        await platformAdminRepo.setPassword(existing._id, hash);
        return { created: false, username: handle };
      }
      await platformAdminRepo.create({ username: handle, name: requireText(name || handle, 'Name', { min: 2 }), passwordHash: hash });
      return { created: true, username: handle };
    },
  };
};
