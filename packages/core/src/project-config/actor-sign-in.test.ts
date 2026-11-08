import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_PATHS, tokenIn, trySignIn } from '../integrations/deploy/sign-in-probe.js';
import {
  ACCOUNT_FIELDS,
  GRAPHQL_SET,
  loginRouteDoor,
  parseActorSecret,
  SIGN_IN_KEYS,
} from './actor-sign-in.js';

// @direct-test-of packages/runner/crates/forge-runner/src/cmd/judge_login/session.rs
// @direct-test-of packages/runner/crates/forge-runner/src/cmd/judge_login/session/described.rs

// Core's write-time sign-in check and judge-login read one secret the same way (ISS-959): a secret
// that passes here is one judge-login signs in with. The account fields are two lists in two
// languages, so this test is what keeps them one (ISS-1083: SidDesk's sign-in reads `identifier`).
const SESSION_RS = fileURLToPath(
  new URL('../../../runner/crates/forge-runner/src/cmd/judge_login/session.rs', import.meta.url),
);

function runnerAccountFields(): string[] {
  const source = readFileSync(SESSION_RS, 'utf8');
  const line = source.match(/const ACCOUNT_FIELDS: \[&str; \d+\] = \[([^\]]*)\];/);
  if (!line?.[1]) throw new Error(`no ACCOUNT_FIELDS array found in ${SESSION_RS}`);
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

function runnerTokenPaths(): string[] {
  const source = readFileSync(SESSION_RS, 'utf8');
  const block = source.match(/const TOKEN_PATHS: \[&str; \d+\] = \[([^\]]*)\];/);
  if (!block?.[1]) throw new Error(`no TOKEN_PATHS array found in ${SESSION_RS}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

function runnerFieldsSaid(): string {
  const source = readFileSync(SESSION_RS, 'utf8');
  const line = source.match(/const FIELDS_SAID: &str = "([^"]*)";/);
  if (!line?.[1]) throw new Error(`no FIELDS_SAID found in ${SESSION_RS}`);
  return line[1];
}

describe('the account fields a secret may name', () => {
  it('are the same list in core and in judge-login', () => {
    expect(runnerAccountFields()).toEqual([...ACCOUNT_FIELDS]);
  });

  it('include identifier, the field a Strapi sign-in reads', () => {
    expect(ACCOUNT_FIELDS).toContain('identifier');
  });

  it("are each named in judge-login's refusal", () => {
    const said = runnerFieldsSaid();
    for (const field of ACCOUNT_FIELDS) expect(said).toContain(`\`${field}\``);
  });
});

describe('where a sign-in answer carries its token (ISS-1094)', () => {
  it('is the same list of paths in core and in judge-login', () => {
    expect(runnerTokenPaths()).toEqual([...TOKEN_PATHS]);
  });

  it("reads Strapi's jwt at the top and SidDesk's under data", () => {
    expect(tokenIn({ jwt: 'a' })).toBe('a');
    expect(tokenIn({ data: { jwt: 'b' } })).toBe('b');
    expect(tokenIn({ token: 'c', data: { jwt: 'd' } })).toBe('c');
  });

  it('reads no token from an empty, nested-deeper or non-string value', () => {
    expect(tokenIn({ token: '' })).toBeNull();
    expect(tokenIn({ data: { data: { jwt: 'e' } } })).toBeNull();
    expect(tokenIn({ jwt: 7 })).toBeNull();
    expect(tokenIn(null)).toBeNull();
    expect(tokenIn('jwt')).toBeNull();
  });
});

// ISS-1141: epod's admin signs in with a GraphQL mutation POSTed to `/graphql`, and its token sits
// at `/data/login/access_token`. The double answers that mutation alone, as a GraphQL server does.
// judge-login's reading of a sign-in the secret describes (ISS-1141), a module of session.rs
const DESCRIBED_RS = fileURLToPath(
  new URL(
    '../../../runner/crates/forge-runner/src/cmd/judge_login/session/described.rs',
    import.meta.url,
  ),
);
const GQL_URL = 'https://admin.epod.example.test/graphql';
const GQL_ACCOUNT = 'judge-1141@epod.test';
const GQL_PASSWORD = 'Corr3ct-H0rse-Battery-1141';
const GQL_TOKEN = 'gql-session-1141';
const MUTATION =
  'mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }';
const GQL_SECRET = {
  username: GQL_ACCOUNT,
  password: GQL_PASSWORD,
  loginRoute: GQL_URL,
  loginBody: { query: MUTATION, variables: { email: '$account', password: '$password' } },
  tokenPath: '/data/login/access_token',
};

function graphqlDouble(answer?: (body: Record<string, unknown>) => Response) {
  const seen: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    if (answer) return answer(body);
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    if (body.query !== MUTATION) {
      return Response.json(
        { errors: [{ message: 'Must provide query string.' }] },
        { status: 422 },
      );
    }
    if (vars.email !== GQL_ACCOUNT || vars.password !== GQL_PASSWORD) {
      return Response.json({ errors: [{ message: `no user ${String(vars.email)}` }], data: null });
    }
    return Response.json({ data: { login: { access_token: GQL_TOKEN } } });
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe('a sign-in the secret describes: a GraphQL mutation (ISS-1141)', () => {
  it('signs in at a GraphQL endpoint answering {data:{login:{access_token}}}', async () => {
    const seen = graphqlDouble();
    const parsed = parseActorSecret(JSON.stringify(GQL_SECRET));
    if ('why' in parsed) throw new Error(parsed.why);
    const answered = await trySignIn(parsed.secret, new URL(GQL_URL));
    expect(answered).toEqual({ answer: 'signs-in', at: GQL_URL, status: 200 });
    // only whole leaves are substituted: the `$email` inside the query string is left as it was
    expect(seen).toEqual([
      { query: MUTATION, variables: { email: GQL_ACCOUNT, password: GQL_PASSWORD } },
    ]);
  });

  it('reads the token at tokenPath alone, and refuses a 2xx with none there or with `errors`', async () => {
    const cases: [string, Response, string][] = [
      [
        'no token at the pointer, though one sits where the fixed list reads',
        Response.json({ data: { access_token: GQL_TOKEN } }),
        'answered 200 with no token at `/data/login/access_token`',
      ],
      [
        'a GraphQL error whose text echoes the account',
        Response.json({ errors: [{ message: `no user ${GQL_ACCOUNT}` }], data: null }),
        'answered 200 with a GraphQL `errors` array, so it signed nobody in',
      ],
      [
        '`errors` beside a token',
        Response.json({
          errors: [{ message: GQL_PASSWORD }],
          data: { login: { access_token: GQL_TOKEN } },
        }),
        'GraphQL `errors` array',
      ],
    ];
    for (const [name, res, says] of cases) {
      graphqlDouble(() => res);
      const parsed = parseActorSecret(JSON.stringify(GQL_SECRET));
      if ('why' in parsed) throw new Error(parsed.why);
      const answered = await trySignIn(parsed.secret, new URL(GQL_URL));
      expect(answered.answer, name).toBe('refused');
      const said = JSON.stringify(answered);
      expect(said, name).toContain(says);
      for (const v of [GQL_ACCOUNT, GQL_PASSWORD, GQL_TOKEN]) expect(said, name).not.toContain(v);
      vi.restoreAllMocks();
    }
  });

  it('refuses a $-word that is no placeholder, a body never sending $password, and a bad pointer, by name', () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { loginBody: { query: MUTATION, variables: { email: '$email', password: '$password' } } },
        '`loginBody` at /variables/email is `$email`',
      ],
      [
        {
          loginBody: {
            query: MUTATION,
            variables: { email: '$account', password: 'pw $password' },
          },
        },
        'has no leaf that is exactly `$password`',
      ],
      [{ loginBody: MUTATION }, '`loginBody` is a JSON object'],
      [{ loginBody: [] }, '`loginBody` is a JSON object'],
      [{ tokenPath: 'data.login.access_token' }, '`tokenPath` is a JSON pointer'],
      [{ tokenPath: '/' }, '`tokenPath` is a JSON pointer'],
    ];
    for (const [extra, says] of cases) {
      const parsed = parseActorSecret(JSON.stringify({ ...GQL_SECRET, ...extra }));
      expect('why' in parsed ? parsed.why : 'signs in', JSON.stringify(extra)).toContain(says);
      if ('why' in parsed) {
        expect(parsed.why).not.toContain(GQL_ACCOUNT);
        expect(parsed.why).not.toContain(GQL_PASSWORD);
      }
    }
  });

  it('sends {<account field>, password} and reads the fixed list where the secret names neither key', async () => {
    const seen = graphqlDouble(() => Response.json({ data: { access_token: GQL_TOKEN } }));
    const { loginBody: _b, tokenPath: _t, ...plain } = GQL_SECRET;
    const parsed = parseActorSecret(JSON.stringify(plain));
    if ('why' in parsed) throw new Error(parsed.why);
    expect((await trySignIn(parsed.secret, new URL(GQL_URL))).answer).toBe('signs-in');
    expect(seen).toEqual([{ username: GQL_ACCOUNT, password: GQL_PASSWORD }]);
  });
});

describe('the keys a secret describes its sign-in with (ISS-1141)', () => {
  it('are the same in core and in judge-login', () => {
    const source = readFileSync(DESCRIBED_RS, 'utf8');
    const keys = source.match(/const SIGN_IN_KEYS: \[&str; \d+\] = \[([^\]]*)\];/);
    if (!keys?.[1]) throw new Error(`no SIGN_IN_KEYS array found in ${DESCRIBED_RS}`);
    expect([...keys[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...SIGN_IN_KEYS]);
    const example = source.match(/const GRAPHQL_SET: &str = r#"(.*)"#;/);
    expect(example?.[1]).toBe(GRAPHQL_SET);
  });

  it('are named, with the GraphQL example, by the refusal that sends a person to the door', () => {
    const door = loginRouteDoor({ projectId: 'p', scope: 'test-store', name: 'forge-bot' });
    expect(door).toContain('`loginBody` and `tokenPath`');
    expect(door).toContain(`PATCH /api/projects/p/secrets/test-store/forge-bot ${GRAPHQL_SET}`);
    // the example is itself a merge the door takes
    const set = (JSON.parse(GRAPHQL_SET) as { set: Record<string, unknown> }).set;
    expect(Object.keys(set).sort()).toEqual(['loginBody', 'loginRoute', 'tokenPath']);
  });
});
