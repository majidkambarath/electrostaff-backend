// Subscription plans. A business without a plan (created before plans existed) has no limits.
const PLANS = {
  trial: { label: 'Free trial', staffLimit: 15 },
  starter: { label: 'Starter', staffLimit: 25 },
  pro: { label: 'Pro', staffLimit: 100 },
  custom: { label: 'Custom', staffLimit: null },
};
const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const trialPlan = (now = new Date()) => ({
  name: 'trial',
  staffLimit: PLANS.trial.staffLimit,
  validUntil: new Date(now.getTime() + TRIAL_DAYS * DAY_MS),
});

// Plan as the app shows it: label, limits, days left, and whether the business is read-only.
const planStatus = (plan, now = new Date()) => {
  if (!plan?.name) return { name: null, label: 'Unlimited', staffLimit: null, validUntil: null, daysLeft: null, expired: false };
  const validUntil = plan.validUntil ? new Date(plan.validUntil) : null;
  const daysLeft = validUntil ? Math.ceil((validUntil.getTime() - now.getTime()) / DAY_MS) : null;
  return {
    name: plan.name,
    label: PLANS[plan.name]?.label || plan.name,
    staffLimit: plan.staffLimit ?? null,
    validUntil,
    daysLeft,
    expired: Boolean(validUntil && validUntil.getTime() < now.getTime()),
  };
};

module.exports = { PLANS, TRIAL_DAYS, trialPlan, planStatus };
