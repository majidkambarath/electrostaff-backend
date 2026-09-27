const { normalizePhone, assertPassword } = require('../../domain/credentials');
const { invalid, unauthorized, forbidden, tooMany, conflict } = require('../../domain/errors');
const { requireText } = require('../validation');

const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

// Sign-in for office users (owner/admin) and staff, plus first-run setup.
// Tokens carry { sub, kind: 'user'|'staff', v: tokenVersion }; bumping tokenVersion (password
// change, access revoked) signs every device out.
module.exports = ({ userRepo, staffRepo, orgService, passwordHasher, tokenService, clock = () => Date.now() }) => {
  const failures = new Map(); // phoneKey -> { count, since }

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

  const userPrincipal = (u) => ({
    kind: 'user',
    id: String(u._id),
    role: u.role,
    name: u.name,
    phone: u.phone,
    organizationId: String(u.organizationId),
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

  const issue = (kind, account) => tokenService.sign({ sub: String(account._id), kind, v: account.tokenVersion || 0 });

  return {
    status: async () => ({ setupRequired: (await userRepo.count()) === 0 }),

    // First run only: creates the owner account for the business.
    setup: async ({ name, phone, password, businessName }) => {
      if ((await userRepo.count()) > 0) throw conflict('Setup is already complete. Please sign in.');
      const ownerName = requireText(name, 'Your name', { min: 2 });
      if (normalizePhone(phone).length !== 10) throw invalid('Enter a valid 10-digit mobile number');
      assertPassword(password);
      const orgId = await orgService.defaultOrgId();
      if (businessName && String(businessName).trim()) await orgService.update(orgId, { name: businessName, ownerName, phone });
      const user = await userRepo.create({
        name: ownerName,
        phone,
        passwordHash: await passwordHasher.hash(password),
        role: 'owner',
        organizationId: orgId,
      });
      return { token: issue('user', user), principal: userPrincipal(user) };
    },

    // One sign-in screen for everyone: office accounts first, then staff with app access.
    login: async ({ phone, password }) => {
      const key = normalizePhone(phone);
      if (key.length !== 10 || !password) throw invalid('Enter your mobile number and password');
      checkRate(key);

      const user = await userRepo.findByPhoneKeyWithSecret(key);
      if (user && (await passwordHasher.verify(password, user.passwordHash))) {
        failures.delete(key);
        userRepo.touchLogin(user._id);
        return { token: issue('user', user), principal: userPrincipal(user) };
      }
      for (const staff of await staffRepo.findForLogin(key)) {
        if (await passwordHasher.verify(password, staff.passwordHash)) {
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
      if (!claims) throw unauthorized('Your session has expired. Please sign in again.');
      if (claims.kind === 'user') {
        const user = await userRepo.findById(claims.sub);
        if (!user || (user.tokenVersion || 0) !== claims.v) throw unauthorized('Your session has expired. Please sign in again.');
        return userPrincipal(user);
      }
      if (claims.kind === 'staff') {
        const staff = await staffRepo.findAuthById(claims.sub);
        if (!staff || (staff.tokenVersion || 0) !== claims.v) throw unauthorized('Your session has expired. Please sign in again.');
        if (!staff.portalEnabled || staff.status === 'inactive') throw forbidden('Your app access has been turned off. Contact the office.');
        return staffPrincipal(staff);
      }
      throw unauthorized();
    },

    // Changing the password signs out other devices and returns a fresh token for this one.
    changePassword: async (principal, { currentPassword, newPassword }) => {
      assertPassword(newPassword);
      const repo = principal.kind === 'user' ? userRepo : staffRepo;
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
    resetOfficePassword: async (phone, newPassword) => {
      const key = normalizePhone(phone);
      assertPassword(newPassword);
      const user = await userRepo.findByPhoneKeyWithSecret(key);
      if (!user) throw invalid(`No owner/admin account uses the mobile number ${phone}`);
      await userRepo.setPassword(user._id, await passwordHasher.hash(newPassword));
      failures.delete(key);
      return { name: user.name, role: user.role };
    },
  };
};
