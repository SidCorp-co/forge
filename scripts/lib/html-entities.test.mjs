import { describe, expect, it } from 'vitest';

import { unesc } from './html-entities.mjs';

describe('unesc', () => {
  it('unescapes each entity it knows', () => {
    expect(unesc('&lt;a&gt;')).toBe('<a>');
    expect(unesc('&quot;x&quot;')).toBe('"x"');
    expect(unesc('&#39;y&#39;')).toBe("'y'");
    expect(unesc('a &amp; b')).toBe('a & b');
  });

  it('does NOT unescape twice, which is what the rule order buys', () => {
    // `&amp;lt;` is a page saying, literally, `&lt;`. Unescape `&amp;` first
    // and it becomes `&lt;` and then `<` — the defect CodeQL's
    // js/double-escaping named. Both assertions go red if `&amp;` moves back
    // to the front of the chain, which is the only way this can regress.
    expect(unesc('&amp;lt;')).toBe('&lt;');
    expect(unesc('&amp;amp;')).toBe('&amp;');
    expect(unesc('&amp;quot;')).toBe('&quot;');
  });

  it('leaves text carrying no entity alone', () => {
    expect(unesc('plain text & nothing')).toBe('plain text & nothing');
    expect(unesc('')).toBe('');
  });
});
