import {
  FILTERED,
  PAT_STRING_PATTERN,
  scrubLogText,
  scrubPatInString,
  scrubSentryEvent,
  scrubStringValues,
} from '@forge/observability';
import { describe, expect, it } from 'vitest';

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

describe('scrubLogText (ISS-284 — Coolify build/deploy log)', () => {
  it('redacts secret-shaped tokens but preserves diagnostic stderr', () => {
    const log = [
      'ENV NODE_ENV=production',
      'ARG BUILD_ID=12345',
      "error: Cannot find module '@codemirror/state'",
      'Authorization: Bearer abcdef123456',
      'token=supersecretvalue',
      'apiKey: my-api-key-xyz',
      'password=hunter2pass',
      'fetching https://coolify.example/cb?access_token=leaked12345&id=7',
      `leaked PAT ${PAT} here`,
    ].join('\n');

    const out = scrubLogText(log, ['integration-secret-token-abc']);
    const lines = out.split('\n');

    // Preserved: build-stage env + the diagnostic the feature exists to surface.
    expect(lines[0]).toBe('ENV NODE_ENV=production');
    expect(lines[1]).toBe('ARG BUILD_ID=12345');
    expect(lines[2]).toBe("error: Cannot find module '@codemirror/state'");

    // Redacted: header / body-key / URL token / PAT.
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toContain('supersecretvalue');
    expect(out).not.toContain('my-api-key-xyz');
    expect(out).not.toContain('hunter2pass');
    expect(out).not.toContain('leaked12345');
    expect(out).not.toContain(PAT);
    expect(out).toContain(FILTERED);
    // URL structure preserved (only the token value is masked).
    expect(out).toContain('https://coolify.example/cb?access_token=[Filtered]&id=7');
  });

  it('redacts literal extraSecrets values (the integration apiToken)', () => {
    const secret = 'cf_pat_9f8e7d6c5b4a';
    const out = scrubLogText(`echo deploying with ${secret} now`, [secret]);
    expect(out).toBe(`echo deploying with ${FILTERED} now`);
  });

  it('ignores too-short extraSecrets to avoid shredding the log', () => {
    const out = scrubLogText('a build a step a done', ['a']);
    expect(out).toBe('a build a step a done');
  });
});

describe('testCredentials scrubbing (ISS-225)', () => {
  it('redacts nested previewDeploy.testCredentials without touching siblings', () => {
    const event = {
      request: {
        data: {
          previewDeploy: {
            stagingUrl: 'https://stg.example.com',
            testCredentials: [{ label: 'qa', username: 'qa@x', password: 'p4ss' }],
          },
        },
      },
    };
    scrubSentryEvent(event);
    const data = event.request.data as {
      previewDeploy: { stagingUrl: string; testCredentials: unknown };
    };
    expect(data.previewDeploy.testCredentials).toBe(FILTERED);
    expect(data.previewDeploy.stagingUrl).toBe('https://stg.example.com');
  });

  it('redacts top-level testCredentials inside a JSON-stringified body', () => {
    const event = {
      request: {
        data: JSON.stringify({ testCredentials: [{ password: 'p' }] }),
      },
    };
    scrubSentryEvent(event);
    const parsed = JSON.parse(event.request.data as string) as {
      testCredentials: unknown;
    };
    expect(parsed.testCredentials).toBe(FILTERED);
  });
});
