import { LIMITS, RESERVED_USERNAMES } from "./constants";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Convert an arbitrary project name into a URL-safe slug. Never returns "". */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.slugMax)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : `${slug || "app"}-app`.slice(0, LIMITS.slugMax);
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= LIMITS.slugMax && SLUG_RE.test(slug);
}

export function isValidUsername(username: string): boolean {
  if (username.length < 3 || username.length > LIMITS.usernameMax) return false;
  if (!USERNAME_RE.test(username)) return false;
  if (RESERVED_USERNAMES.has(username)) return false;
  return true;
}

export type UsernameIssue = "too_short" | "too_long" | "bad_chars" | "reserved";

export function validateUsername(username: string): UsernameIssue | null {
  if (username.length < 3) return "too_short";
  if (username.length > LIMITS.usernameMax) return "too_long";
  if (!USERNAME_RE.test(username)) return "bad_chars";
  if (RESERVED_USERNAMES.has(username)) return "reserved";
  return null;
}
