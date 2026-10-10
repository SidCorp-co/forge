// Every door a credential is admitted at, and what a chat credential meets there (REQ-30 BC-4,
// ISS-439). A chat credential is a token core minted for a chat — an Agent session's turn token, the
// Assistant's turn token, an agreed proposal's token — and every one is a PAT, so it is never a
// session JWT, and the one chat write rule has to run wherever a PAT is admitted. The integration
// suite (`tests/integration/chat-agreement-default-e2e.test.ts`) presents a real turn token at each
// door.
//
// A door is found by where a credential ARRIVES, not by how it is checked (round 6: the review judge
// admitted a bearer with timingSafeEqual, a digest lookup, hono/jwt and a verifier in a slot, and a
// walk seeded only on argon2 and jose saw none of them). So every read of a request input in core —
// a header, a query key, a cookie — names an input this file classifies, a credential or not, and
// a read this file has not classified is red. A credential read seeds the walk, beside the
// primitives a secret is checked with; the walk then follows bindings as before (any alias, a
// namespace or default import, a dynamic import, a re-export or `export *`, `export default`), and
// only the gates named below stop it, because the routes behind a gate are behind its door. A
// verifier handed to another module's function as a value is refused, since nothing can follow it
// from there: a door is where its verifier is called.
//
// Not walked: a secret in a validated body, path or query field (`c.req.valid`). Such a door is
// named only when it reaches a primitive below.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computedKey, inputKey } from './credential-inputs.fixture.js';
import { readDoors } from './credential-walk.fixture.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a presented secret is checked with, or read through, by the package exporting it. */
const PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  argon2: ['verify'],
  jose: ['jwtVerify', 'jwtDecrypt', 'compactVerify', 'flattenedVerify', 'generalVerify'],
  'hono/jwt': ['verify'],
  'hono/cookie': ['getCookie', 'getSignedCookie'],
  'hono/bearer-auth': ['bearerAuth'],
  'hono/basic-auth': ['basicAuth'],
  'node:crypto': ['timingSafeEqual', 'verify', 'createVerify'],
  crypto: ['timingSafeEqual', 'verify', 'createVerify'],
};

/**
 * Every request input core reads, by `<kind>:<name>`: what it carries. A credential input seeds the
 * walk; a plain one says why no credential arrives in it.
 */
const CREDENTIAL_INPUTS: Readonly<Record<string, string>> = {
  'header:authorization': 'a bearer token: a PAT, a session JWT, a box token',
  'header:cookie': 'the session, refresh and preview viewer cookies',
  'header:sec-websocket-protocol': 'a browser socket’s bearer, as forge.bearer.<token>',
  'query:ticket': 'a preview ticket, spent once for the viewer cookie',
};

const PLAIN_INPUTS: Readonly<Record<string, string>> = {
  'header:accept': 'the media types a browser takes',
  'header:cf-ray': 'the edge’s trace id',
  'header:content-encoding': 'how a preview’s answer is compressed',
  'header:content-length': 'a chat server’s answer size',
  'header:content-type': 'the body’s media type',
  'header:host': 'the host a request names',
  'header:link': 'Sentry’s next page',
  'header:origin': 'the page a request came from',
  'header:referer': 'the page a request came from',
  'header:sec-fetch-dest': 'what a browser is loading',
  'header:user-agent': 'the client’s name',
  'header:x-forge-capabilities': 'what a client renders',
  'header:x-forge-project-slug': 'which project an /mcp call names',
  'header:x-forge-unresolved-ref': 'a route reference left unresolved',
  'header:x-forwarded-for': 'the client address the proxy saw',
  'header:x-forwarded-host': 'the host the proxy saw',
  'header:x-forwarded-proto': 'the scheme the proxy saw',
  'header:x-github-delivery': 'a GitHub delivery id, read after its signature verified',
  'header:x-github-event': 'a GitHub event name, read after its signature verified',
  'header:x-gitlab-event': 'a GitLab event name, read after its token verified',
  'header:x-gitlab-event-uuid': 'a GitLab event id, read after its token verified',
  'header:x-gitlab-webhook-uuid': 'a GitLab hook id, read after its token verified',
  'header:x-next-page': 'GitLab’s next page',
  'header:x-real-ip': 'the client address the proxy saw',
  'header:x-request-id': 'a trace id',
  'query:projectid': 'which project a route reference names',
};

const UPSTREAM = 'the headers of an answer core received, never a request to core';
const DATA = 'a headers field of a stored or declared shape, never a request to core';

/**
 * A read whose name is computed, or that takes the whole header set, by `<module> <expression>`:
 * whether a credential arrives through it, and what it is.
 */
const COMPUTED_READS: Readonly<Record<string, { credential: boolean; why: string }>> = {
  'assistant/agreement/execute.ts call.headers': { credential: false, why: DATA },
  'assistant/agreement/rest-hold.ts c.req.header(name)': {
    credential: false,
    why: 'KEPT_HEADERS: x-forge-capabilities only',
  },
  'ecosystem/contract/openapi-schema-slots.ts v.headers': { credential: false, why: DATA },
  'integration-door/webhook-inbound-routes.ts c.req.header(m.header)': {
    credential: false,
    why: 'which provider’s event header is present',
  },
  'integration-door/webhook-inbound-routes.ts c.req.header(map.signatureHeader)': {
    credential: true,
    why: 'a provider’s signature or shared token',
  },
  'integration-door/webhook-inbound-routes.ts c.req.raw.headers': {
    credential: false,
    why: 'handed to the adapter after the signature verified; it reads event headers by name',
  },
  'integrations/deploy/kept-probe-request.ts request.headers': { credential: false, why: DATA },
  'integrations/github/client.ts answered.headers': { credential: false, why: UPSTREAM },
  'integrations/github/client.ts args.headers': { credential: false, why: UPSTREAM },
  'integrations/github/client.ts err.headers': { credential: false, why: UPSTREAM },
  'integrations/github/octokit.ts answered.headers': { credential: false, why: UPSTREAM },
  'integrations/github/octokit.ts response.headers': { credential: false, why: UPSTREAM },
  'integrations/github/publish-refusal.ts err.headers?.get(name)': {
    credential: false,
    why: UPSTREAM,
  },
  'issues/criteria/probe-rules.ts probe.request.headers': { credential: false, why: DATA },
  'pipeline/failure-classifier.ts (meta as { headers?: unknown }).headers': {
    credential: false,
    why: UPSTREAM,
  },
  'pipeline/failure-classifier.ts err.headers': { credential: false, why: UPSTREAM },
  'pipeline/failure-classifier.ts err?.headers': { credential: false, why: UPSTREAM },
  'pipeline/failure-classifier.ts resp.headers': { credential: false, why: UPSTREAM },
  'pipeline/failure-classifier.ts resp?.headers': { credential: false, why: UPSTREAM },
  'previews/relay.ts answer.headers': { credential: false, why: UPSTREAM },
  'previews/relay.ts req.headers': {
    credential: true,
    why: 'a viewer’s request forwarded to the preview, Forge’s cookies cut out',
  },
  'release-batch/probe-run.ts probe.request.headers': { credential: false, why: DATA },
};

/** Each module that admits a presented credential, and what a chat credential meets in it. */
const DOORS: Readonly<Record<string, string>> = {
  'credentials/pat.ts': 'defines verifyPat, the one PAT verification every door below calls',
  'credentials/jwt.ts':
    'defines verifyUserToken: a session JWT, which no chat credential is (every one is a PAT)',
  'credentials/device-credential.ts':
    'readBoxToken reads a token core handed a chat as handed, never as the box it is fenced to',
  'middleware/pat-rest-surface.ts':
    'beginPatRequest, called only by auth.ts:admitPat, which runs admitChatWrite on every write',
  'middleware/auth.ts':
    'requireAuth and requireUserOrDevice admit a chat credential through admitPat, so the chat write rule runs',
  'middleware/require-device.ts':
    'requireDevice refuses a chat credential TURN_CREDENTIAL_NOT_A_BOX',
  'middleware/require-pat.ts':
    'requirePat admits /mcp, where mcp/server.ts asks rest-hold.ts:refuseChatToolWrite before a tool runs',
  'project-config/routes.ts':
    'callingDevice is a read on a route requireAuth admits; a chat credential names no device there',
  'project-config/testing-secrets-routes.ts':
    'a job credential reads one job’s testing secrets: GET only, decided by the job it names',
  'ws/server.ts': 'resolveBearer opens the socket for a person or a box, never a chat credential',
  'auth/password.ts': 'defines verifyPassword: a password hash, which no chat credential is',
  'auth/login.ts':
    'session sign-in takes an email and a password and refuses an agent; a chat credential is neither',
  'auth/reauth.ts':
    'a password recheck behind requireAuth, where the chat write rule runs first; a chat credential carries no password',
  'credentials/refresh-token.ts':
    'defines verifyRefreshToken: a refresh token hash, which a PAT never matches',
  'auth/service.ts':
    'rotateRefreshToken matches a refresh token under its prefix; a chat credential is a PAT, never one',
  'auth/refresh.ts':
    'reads the refresh cookie and refuses an agent; a chat credential is never a refresh token',
  'auth/oauth/state.ts':
    'defines verifyState: the OAuth state cookie, a JWT under its own issuer that admits no caller',
  'auth/oauth/handler.ts':
    'handleCallback signs a person in from the provider’s answer and its state cookie, never a presented token',
  'previews/ticket.ts':
    'a preview ticket and viewer cookie are JWTs under their own issuers; a PAT verifies as neither',
  'previews/relay.ts':
    'the preview host admits a viewer by its cookie or a ticket it spends, never a bearer token',
  'middleware/bearer.ts':
    'reads the Authorization header and session cookies and admits nothing; each caller is named here',
  'credentials/cookie.ts':
    'requestCookieValues reads forge_auth cookies, which carry only sessions core wrote, never a PAT',
  'lib/hmac.ts':
    'checks a provider’s body signature or shared webhook token; a chat credential is neither',
  'integration-door/webhook-inbound-routes.ts':
    'a webhook verified against its binding’s secret; a chat credential in that header verifies as nothing',
  'integrations/github/connect.ts':
    'verifyConnectState checks an HMAC-signed connect state, which a PAT never is',
  'integration-door/github-connect-routes.ts':
    'the GitHub callbacks check their connect state behind requireAuth, where the chat write rule runs',
};

/**
 * Exported bindings that admit through a verifier and are mounted as middleware: the routes they
 * guard sit behind the door that exports them, so the walk stops here.
 */
const GATES: Readonly<Record<string, readonly string[]>> = {
  'middleware/auth.ts': ['requireAuth', 'requireUserOrDevice'],
  'middleware/require-device.ts': ['requireDevice'],
  'middleware/require-pat.ts': ['requirePat'],
  'auth/oauth/handler.ts': ['handleCallback'],
  'previews/relay.ts': ['withPreviewHosts', 'relayPreviewRequest', 'relayPreviewUpgrade'],
  'ws/server.ts': ['attachWs'],
};
const read = readDoors({
  src: SRC,
  primitives: PRIMITIVES,
  credentialInputs: CREDENTIAL_INPUTS,
  computedReads: COMPUTED_READS,
  gates: GATES,
});

describe('every door a credential is admitted at is named, with what a chat credential meets there', () => {
  it('classifies every request input core reads, as a credential or not', () => {
    const unclassified: string[] = [];
    for (const mod of read.modules) {
      for (const r of read.reads.get(mod.key) ?? []) {
        const known =
          r.name === null
            ? computedKey(mod, r) in COMPUTED_READS
            : inputKey(r) in CREDENTIAL_INPUTS || inputKey(r) in PLAIN_INPUTS;
        if (!known)
          unclassified.push(r.name === null ? computedKey(mod, r) : `${mod.key} ${inputKey(r)}`);
      }
    }
    expect(unclassified.sort()).toEqual([]);
  });

  it('classifies no input core does not read', () => {
    const seen = new Set<string>();
    for (const mod of read.modules) {
      for (const r of read.reads.get(mod.key) ?? []) {
        seen.add(r.name === null ? computedKey(mod, r) : inputKey(r));
      }
    }
    const listed = [
      ...Object.keys(CREDENTIAL_INPUTS),
      ...Object.keys(PLAIN_INPUTS),
      ...Object.keys(COMPUTED_READS),
    ];
    expect(listed.filter((k) => !seen.has(k))).toEqual([]);
  });

  it('names exactly the modules a credential arrives at or is checked in, however it is bound', () => {
    expect(read.doors).toEqual(Object.keys(DOORS).sort());
  });

  it('hands no verifier to another module as a value, where no walk can follow it', () => {
    expect([...read.handoffs.values()].flat().sort()).toEqual([]);
  });

  it('names each gate as a binding its door exports that reaches a verifier', () => {
    for (const [door, gates] of Object.entries(GATES)) {
      for (const gate of gates) expect(read.reaching.get(door), `${door}:${gate}`).toContain(gate);
    }
  });

  it('/mcp asks the chat write rule before a tool runs', () => {
    const mcp = readFileSync(join(SRC, 'mcp/server.ts'), 'utf8');
    expect(mcp).toMatch(/await chatToolWriteRefusal\(name, args,/);
  });

  it('the only PAT admission on the REST plane runs the chat write rule', () => {
    const auth = readFileSync(join(SRC, 'middleware/auth.ts'), 'utf8');
    const admitPat = auth.slice(auth.indexOf('async function admitPat('));
    expect(admitPat.slice(0, admitPat.indexOf('\n}\n'))).toContain('await admitChatWrite(c);');
    const surface = 'middleware/pat-rest-surface.ts';
    const binders = read.modules
      .filter((m) =>
        [...m.bindings.values()].some(
          (b) => b.from === surface && ('namespace' in b || b.name === 'beginPatRequest'),
        ),
      )
      .map((m) => m.key);
    expect(binders.sort()).toEqual(['middleware/auth.ts']);
  });
});
