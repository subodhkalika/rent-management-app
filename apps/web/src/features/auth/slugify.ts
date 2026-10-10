/** Derives a URL-safe fragment from a display name. May be empty — see below. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The slug an organization is created with.
 *
 * Better Auth requires one and it is globally unique, but nothing in this app ever
 * shows it: no URL contains it, no API reads it, and it appears on no screen. So it
 * is generated rather than asked for.
 *
 * Asking for it caused two failures that had nothing to do with the person typing.
 * A name in a non-Latin script slugifies to an empty string — "मेरो घर" produced ""
 * — so the field failed validation and the organization could not be created at all.
 * And because the slug is unique across every landlord, two unrelated people both
 * naming their organization "Mero Ghar" meant the second was told the URL was taken,
 * blocked by a stranger's name they cannot see.
 *
 * `org` is the fallback for a name that yields nothing. It will collide immediately
 * and often, which is fine: `withSuffix` is what actually resolves that.
 */
export function organizationSlugFor(name: string): string {
  return slugify(name) || 'org';
}

/**
 * A disambiguated variant, for when the plain slug is taken.
 *
 * Random rather than a counter: a counter needs to know how many already exist,
 * which is a query this client cannot make and a race it would lose anyway. Nobody
 * reads this string, so it only has to be unlikely to repeat.
 */
export function withSuffix(slug: string): string {
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}
