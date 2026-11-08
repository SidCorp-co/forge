import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_PATHS, tokenIn, trySignIn } from '../integrations/deploy/sign-in-probe.js';
import { ACCOUNT_FIELDS, parseActorSecret } from './actor-sign-in.js';

// @direct-test-of packages/runner/crates/forge-runner/src/cmd/judge_login/session.rs

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
      return Response.json({ errors: [{ message: 'Must provide query string.' }] }, { status: 422 });
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
});
