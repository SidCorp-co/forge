import { describe, expect, it } from 'vitest';
import {
  FILTERED,
  PAT_STRING_PATTERN,
  scrubPatInString,
  scrubSentryEvent,
  scrubStringValues,
} from '@forge/observability';

const PAT = 'forge_pat_prd_abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

describe('PAT scrubbing (ISS-150)', () => {
  it('scrubPatInString redacts PAT plaintext in arbitrary text', () => {
    const out = scrubPatInString(`leaked: ${PAT} end`);
    expect(out).toBe(`leaked: ${FILTERED} end`);
  });

  it('scrubStringValues walks nested objects and arrays', () => {
    const obj: Record<string, unknown> = {
      a: PAT,
      b: { inner: PAT, list: [PAT, 'safe'] },
      c: ['a', PAT],
    };
    scrubStringValues(obj);
    expect(obj.a).toBe(FILTERED);
    expect((obj.b as { inner: string }).inner).toBe(FILTERED);
    expect((obj.b as { list: string[] }).list[0]).toBe(FILTERED);
    expect((obj.b as { list: string[] }).list[1]).toBe('safe');
    expect((obj.c as string[])[1]).toBe(FILTERED);
  });

  it('scrubSentryEvent redacts PAT in headers, url, body, breadcrumbs', () => {
    const event = {
      request: {
        headers: { authorization: `Bearer ${PAT}` },
        url: `https://api.example.com/mcp?leaked=${PAT}`,
        data: JSON.stringify({ note: `token is ${PAT}` }),
      },
      breadcrumbs: [
        { message: `incoming request with ${PAT}`, data: { url: `https://x?t=${PAT}` } },
      ],
    };
    scrubSentryEvent(event);
    expect(event.request.headers.authorization).toBe(FILTERED);
    expect(event.request.url.includes(PAT)).toBe(false);
    expect((event.request.data as string).includes(PAT)).toBe(false);
    expect(event.breadcrumbs[0].message.includes(PAT)).toBe(false);
    const bdata = event.breadcrumbs[0].data as { url: string };
    expect(bdata.url.includes(PAT)).toBe(false);
  });

  it('PAT_STRING_PATTERN matches every env tag', () => {
    expect('forge_pat_dev_a'.match(PAT_STRING_PATTERN)).not.toBeNull();
    expect('forge_pat_stg_a'.match(PAT_STRING_PATTERN)).not.toBeNull();
    expect('forge_pat_prd_a'.match(PAT_STRING_PATTERN)).not.toBeNull();
  });
});
