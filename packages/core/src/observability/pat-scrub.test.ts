import {
  FILTERED,
  PAT_STRING_PATTERN,
  scrubBodyKeys,
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
    expect(event.breadcrumbs[0]?.message.includes(PAT)).toBe(false);
    const bdata = event.breadcrumbs[0]?.data as { url: string };
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

describe('scrubLogText env-assignment redaction (ISS-412)', () => {
  it('redacts SHOUTING_CASE secret-suffix env assignments', () => {
    const log = [
      'POSTGRES_PASSWORD=p@ss',
      'JWT_SECRET=jwt-val',
      'DEVICE_TOKEN_PEPPER=pep',
      'INTEGRATION_MASTER_KEY=imk',
      'GITHUB_OAUTH_CLIENT_SECRET=gh',
      'EMBEDDINGS_API_KEY=eak',
      'SENTRY_DSN=https://abc@sentry.io/1',
      'export AWS_SECRET_ACCESS_KEY=aws',
    ].join('\n');
    const out = scrubLogText(log);
    expect(out).toBe(
      [
        `POSTGRES_PASSWORD=${FILTERED}`,
        `JWT_SECRET=${FILTERED}`,
        `DEVICE_TOKEN_PEPPER=${FILTERED}`,
        `INTEGRATION_MASTER_KEY=${FILTERED}`,
        `GITHUB_OAUTH_CLIENT_SECRET=${FILTERED}`,
        `EMBEDDINGS_API_KEY=${FILTERED}`,
        `SENTRY_DSN=${FILTERED}`,
        `export AWS_SECRET_ACCESS_KEY=${FILTERED}`,
      ].join('\n'),
    );
  });

  it('does not redact non-secret env assignments', () => {
    const log = [
      'NODE_ENV=production',
      'HOSTNAME=coolify-1',
      'SERVICE_NAME_WEB=web',
      'DOCKER_BUILDKIT=1',
      'PORT=3000',
    ].join('\n');
    expect(scrubLogText(log)).toBe(log);
  });

  it('preserves the ISS-277 diagnostic stderr line', () => {
    const log = [
      'JWT_SECRET=leak',
      "error: Cannot find module '@codemirror/state'",
      'NODE_ENV=production',
    ].join('\n');
    const out = scrubLogText(log);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`JWT_SECRET=${FILTERED}`);
    expect(lines[1]).toBe("error: Cannot find module '@codemirror/state'");
    expect(lines[2]).toBe('NODE_ENV=production');
  });

  it('is line-anchored — mid-line env-shaped fragments are not eaten by the rule', () => {
    // The env rule is anchored to start-of-line; a `JWT_SECRET=x` fragment in
    // the middle of a sentence does NOT match it. Mid-line secret literals
    // are out of scope (header / URL / body-key rules handle those shapes).
    const out = scrubLogText('not env JWT_SECRET=x');
    expect(out).toBe('not env JWT_SECRET=x');
  });

  it('redacts secret tokens sandwiched mid-key, not only as a suffix (live shape)', () => {
    // The first ISS-412 ship missed the production env-var names because the
    // suffix-only regex required the secret token at end-of-key. Real Coolify
    // env dumps append a service tag (`_CORE`, `_WEB`, `_ID`) so the secret
    // token sits in the middle. These exact lines leaked in deploy 19e21c95.
    const log = [
      'SENTRY_DSN_CORE=https://abc@logs.canawan.com/36',
      'SENTRY_DSN_WEB=https://def@logs.canawan.com/37',
      'AWS_SECRET_ACCESS_KEY=aws',
      'AWS_ACCESS_KEY_ID=aki',
    ].join('\n');
    const out = scrubLogText(log);
    expect(out).toBe(
      [
        `SENTRY_DSN_CORE=${FILTERED}`,
        `SENTRY_DSN_WEB=${FILTERED}`,
        `AWS_SECRET_ACCESS_KEY=${FILTERED}`,
        `AWS_ACCESS_KEY_ID=${FILTERED}`,
      ].join('\n'),
    );
  });

  it('does not redact non-secret env names that merely contain a secret-token substring', () => {
    // Segment-match (not substring-match) keeps these readable: `SERVICE_URL_CORE`
    // has no secret token as a full segment; `GITHUB_OAUTH_CLIENT_ID` ends in
    // `ID` which is not in the token set. Both were preserved in the live log.
    const log = [
      'SERVICE_URL_CORE=https://forge-beta-api.sidcorp.co',
      'GITHUB_OAUTH_CLIENT_ID=ghid',
      'KEYBOARD=qwerty',
    ].join('\n');
    expect(scrubLogText(log)).toBe(log);
  });
});

describe('testCredentials scrubbing (ISS-225)', () => {
  it('redacts nested environments.testCredentials without touching siblings', () => {
    const event = {
      request: {
        data: {
          environments: {
            preview: { url: 'https://stg.example.com' },
            testCredentials: [{ label: 'qa', username: 'qa@x', password: 'p4ss' }],
          },
        },
      },
    };
    scrubSentryEvent(event);
    const data = event.request.data as {
      environments: { preview: { url: string }; testCredentials: unknown };
    };
    expect(data.environments.testCredentials).toBe(FILTERED);
    expect(data.environments.preview.url).toBe('https://stg.example.com');
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

// ISS-1036 — the two shapes a Google service account puts into a log. Neither
// was covered before: `privateKey` was not a scrubbed key name, and a PEM block
// has no token-shaped signature the per-line value rules can find — the value
// match stops at the first space, which in `-----BEGIN PRIVATE KEY-----` comes
// before any key material. The same gap covered GitHub's App PEM, which this
// repo has stored since ISS-946.
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDexampleexample',
  'c2VjcmV0IGtleSBtYXRlcmlhbCB0aGF0IG11c3QgbmV2ZXIgcmVhY2ggYSBsb2c=',
  '-----END PRIVATE KEY-----',
].join('\n');
const PEM_ESCAPED = PEM.split('\n').join('\\n');
const GOOGLE_TOKEN = 'ya29.a0AfB_byC3xampleTokenMaterial-_0123456789';

describe('a PEM private key (ISS-1036)', () => {
  it('is redacted whole, across the lines it spans', () => {
    const out = scrubLogText(`starting up\n${PEM}\ndone`);
    expect(out).not.toContain('c2VjcmV0IGtleSBtYXRlcmlhbA');
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
    expect(out).toContain(FILTERED);
  });

  it('is redacted in the \\n-escaped form a service-account key file carries', () => {
    const line = `{"type":"service_account","private_key":"${PEM_ESCAPED}"}`;
    const out = scrubLogText(line);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
  });

  it('is redacted even when the log was cut before the END marker', () => {
    const truncated = PEM.split('\n').slice(0, 2).join('\n');
    const out = scrubLogText(`${truncated}`);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
  });

  // cm:guard the case the `{16,}` bound in PEM_PRIVATE_KEY_HEAD_PATTERN exists for. With the loose `[A-Za-z0-9+/=\\s]*` continuation this goes red: the unterminated marker swallows every word after it, and a build log with one truncated key comes back with its error message redacted.
  it('a truncated key does not swallow the build output after it', () => {
    const truncated = PEM.split('\n').slice(0, 2).join('\n');
    const out = scrubLogText(`${truncated}\nerror: Cannot find module '@codemirror/state'`);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
    expect(out).toContain("Cannot find module '@codemirror/state'");
  });

  // cm:guard the label is bounded — `(?:[A-Z]{1,12} ){0,3}` and not `[A-Z ]*` —
  // because the loose class overlaps the literal `PRIVATE KEY` after it, so an
  // input carrying many `-----BEGIN ` markers made the engine walk the class back
  // one character at a time at every one of them (CodeQL `js/polynomial-redos`,
  // high, on PR 430, against input that is a build log nobody controls). The
  // bound is what this case defends: the six labels OpenSSL actually emits all
  // sit inside it, and narrowing it further to buy the ReDoS fix would trade
  // coverage of a credential for it, which is the wrong direction — a key that
  // reaches a log fails silently and permanently.
  it('covers every PEM label OpenSSL emits', () => {
    for (const label of [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'DSA PRIVATE KEY',
    ]) {
      const out = scrubLogText(`-----BEGIN ${label}-----\nMIIEvQIBADANBgkqhkiG9w0AAAA`);
      expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
    }
  });

  it('leaves the diagnostic around it alone — this is not whole-line masking', () => {
    const out = scrubLogText(`error: Cannot find module '@codemirror/state'\n${PEM}`);
    expect(out).toContain("Cannot find module '@codemirror/state'");
  });

  it('is redacted by key name in a structured payload too', () => {
    const body: Record<string, unknown> = {
      privateKey: PEM,
      private_key: PEM,
      serviceAccountJson: '{"private_key":"x"}',
      clientEmail: 'forge@forge-sheets-1.iam.gserviceaccount.com',
    };
    scrubBodyKeys(body);
    expect(body.privateKey).toBe(FILTERED);
    expect(body.private_key).toBe(FILTERED);
    expect(body.serviceAccountJson).toBe(FILTERED);
    // Identity is not a secret and must survive — a card that cannot name the
    // account is a card an operator cannot act on.
    expect(body.clientEmail).toBe('forge@forge-sheets-1.iam.gserviceaccount.com');
  });

  it('is redacted inside a Sentry event body', () => {
    const event = {
      request: { data: { secrets: { privateKey: PEM } } },
    };
    const out = scrubSentryEvent(event);
    expect(JSON.stringify(out)).not.toContain('MIIEvQIBADANBgkqhkiG9w0');
  });
});

describe('a minted Google access token (ISS-1036)', () => {
  it('is redacted in free-form log text', () => {
    const out = scrubLogText(`GET /v4/spreadsheets with Bearer ${GOOGLE_TOKEN}`);
    expect(out).not.toContain('a0AfB_byC3xampleTokenMaterial');
  });

  it('is redacted wherever it turns up, not only after a key name', () => {
    expect(scrubPatInString(`token is ${GOOGLE_TOKEN} ok`)).toBe(`token is ${FILTERED} ok`);
  });

  it('is redacted inside nested event values', () => {
    const obj: Record<string, unknown> = { a: { b: [GOOGLE_TOKEN] } };
    scrubStringValues(obj);
    expect(JSON.stringify(obj)).not.toContain('a0AfB_byC3xampleTokenMaterial');
  });

  it('does not eat an ordinary word that merely starts with ya', () => {
    expect(scrubLogText('yarn install finished')).toBe('yarn install finished');
  });
});

/**
 * ISS-1069 — the credentials keep being redacted after `previewDeploy` became `environments`.
 *
 * `SCRUB_BODY_KEYS` matches on the KEY NAME and not on a path, so the redaction survives the column
 * rename if and only if the credentials keep that spelling. That is a property to PROVE with a
 * planted value rather than to reason about: a scrubber that stops matching does not throw — it
 * succeeds, and the secret goes to a log.
 *
 * `SCRUB_BODY_KEYS` also contains `password`, which is why a test that only watches a planted
 * password disappear proves nothing about `testCredentials` at all: it would stay green with
 * `testCredentials` removed from the set entirely. The assertion is that the WHOLE subtree is
 * `[Filtered]`.
 */
describe('the deployment credentials, at their `environments` path', () => {
  const PLANTED = {
    environments: {
      preview: { url: 'https://stg.example.com' },
      live: { url: 'https://app.example.com', commitUrl: 'https://api.example.com/health' },
      limits: 'the QA account reaches no other project',
      testCredentials: [
        { label: 'Admin', username: 'planted-qa@example.com', password: 'planted-pw-9f2' },
      ],
    },
  };

  type Env = {
    live: Record<string, unknown>;
    preview: Record<string, unknown>;
    limits: unknown;
    testCredentials: unknown;
  };

  function scrubbed(): { environments: Env } {
    const body = structuredClone(PLANTED) as unknown as { environments: Env };
    scrubBodyKeys(body);
    return body;
  }

  it('replaces the whole testCredentials value with [Filtered]', () => {
    expect(scrubbed().environments.testCredentials).toBe(FILTERED);
  });

  it('leaves neither the planted username nor the planted password anywhere in the payload', () => {
    const text = JSON.stringify(scrubbed());
    expect(text).not.toContain('planted-qa@example.com');
    expect(text).not.toContain('planted-pw-9f2');
  });

  // cm:guard the NEGATIVE half. A scrubber that redacted the addresses too would be safe and
  // useless: the URLs and the limits are what an operator needs to read a card at all, and they are
  // not secrets. This is what stops a future widening of the key set from being invisible.
  it('leaves the live url, the preview url and the limits unredacted in the same payload', () => {
    const env = scrubbed().environments;
    expect(env.live.url).toBe('https://app.example.com');
    expect(env.live.commitUrl).toBe('https://api.example.com/health');
    expect(env.preview.url).toBe('https://stg.example.com');
    expect(env.limits).toBe('the QA account reaches no other project');
  });
});
