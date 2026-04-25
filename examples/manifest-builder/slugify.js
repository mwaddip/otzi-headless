const FALLBACK = 'manifest';
const MAX_LEN = 64;

export function slugify(input) {
  if (typeof input !== 'string') return FALLBACK;
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0) return FALLBACK;
  return normalized.slice(0, MAX_LEN);
}
