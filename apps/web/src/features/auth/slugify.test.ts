import { describe, it, expect } from 'vitest';
import { slugify, organizationSlugFor, withSuffix } from './slugify';

describe('organizationSlugFor', () => {
  it('derives a readable slug from a Latin name', () => {
    expect(organizationSlugFor('Mero Ghar')).toBe('mero-ghar');
    expect(organizationSlugFor('  Balaju  Ghar  ')).toBe('balaju-ghar');
  });

  it('never returns an empty slug for a non-Latin name', () => {
    // The bug that removing the field fixed: these all slugify to '', which failed
    // the form's min(1) rule, so an organization with a Devanagari or Cyrillic name
    // could not be created at all.
    for (const name of ['मेरो घर', 'घर', 'Радха', '北京']) {
      expect(slugify(name)).toBe('');
      expect(organizationSlugFor(name)).toBe('org');
    }
  });

  it('strips punctuation rather than emitting it', () => {
    expect(organizationSlugFor("O'Brien & Sons, Ltd.")).toBe('o-brien-sons-ltd');
  });
});

describe('withSuffix', () => {
  it('keeps the readable part and adds a disambiguator', () => {
    const out = withSuffix('mero-ghar');
    expect(out.startsWith('mero-ghar-')).toBe(true);
    expect(out.length).toBeGreaterThan('mero-ghar-'.length);
  });

  it('is unlikely to repeat — two calls differ', () => {
    const seen = new Set(Array.from({ length: 50 }, () => withSuffix('x')));
    expect(seen.size).toBeGreaterThan(45);
  });
});
