import { describe, expect, it } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { admitSiteRecord, type SiteChannel } from './release-sites.js';

const one: SiteChannel[] = [{ site: 'production', bindingId: 'b-1', url: null }];
const ctx = (fallback: string) => ({ metadata: null, fallback, remedy: 'Deploy it.' });

// debt 9339fcb5: a finish with no commit and no version recorded the one site serving '', shipped
describe('a production of one site whose record names none', () => {
  it('records the site serving the commit or version the finish names', () => {
    expect(admitSiteRecord(one, undefined, ctx('0.4.0'))).toEqual([
      { name: 'production', serves: '0.4.0' },
    ]);
  });

  it('refuses it as not shipped where neither a commit nor a version names what it serves', () => {
    let thrown: unknown = null;
    try {
      admitSiteRecord(one, undefined, ctx(''));
    } catch (err) {
      thrown = err;
    }
    expect(isRefusal(thrown, 'RELEASE_SITE_NOT_SHIPPED')).toBe(true);
  });
});
