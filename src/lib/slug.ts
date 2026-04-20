/**
 * Slug normalization and validation.
 *
 * The slug is the single riskiest user-supplied value in this tool — it ends up
 * as a directory name, a GitHub repo name, and (via the repo name) a URL path
 * component. Keep it boring and strictly validated.
 */

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

/** Normalize a freeform client name into a candidate slug. */
export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '') // strip non-word/space/hyphen
    .replace(/[\s_]+/g, '-') // whitespace/underscore → hyphen
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 40);
}

/** Returns true if the slug is safe to use. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Throws if the slug is invalid. Use this at every boundary where the slug is
 * about to be handed to git, the filesystem, or the GitHub API.
 */
export function assertValidSlug(slug: string): asserts slug is string {
  if (!isValidSlug(slug)) {
    throw new Error(
      `[slug] Invalid slug "${slug}". Must match ${SLUG_RE.source}`,
    );
  }
}

/** The canonical per-client repo name. */
export function repoNameFromSlug(slug: string): string {
  assertValidSlug(slug);
  return `dashboard-${slug}`;
}
