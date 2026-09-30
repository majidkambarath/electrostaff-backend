// Organization (tenant) rules.

// URL-safe identifier from a business name: "Fayas Test Co." -> "fayas-test-co".
const slugify = (name) =>
  String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'business';

const ORG_STATUSES = ['active', 'suspended'];

module.exports = { slugify, ORG_STATUSES };
