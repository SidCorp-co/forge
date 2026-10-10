// Every door a credential is presented at, and what a chat credential meets there (REQ-30 BC-4,
// ISS-439). A chat credential is a token core minted for a chat — an Agent session's turn token, the
// Assistant's turn token, an agreed proposal's token — and every one is a PAT, so it is never a
// session JWT, and the one chat write rule has to run wherever a PAT is admitted. The integration
// suite (`tests/integration/chat-agreement-default-e2e.test.ts`) presents a real turn token at each
// door.
//
// Default-deny, read by type (round 7). Rounds 5 and 6 recognised a door by the forms they had been
// shown (verifier names, then request-read syntax), and each reviewer found a form outside the list.
// Here credential-access.fixture.ts type-checks core's src and visits every expression whose static
// type is a request carrier, whatever it is named: each use is a member credential-inputs.fixture.ts
// classifies, a typed flow read as a slice, or a refusal naming what cannot be read. Every input
// read by name, every whole read and every hono-family import is classified there as a credential
// or not; anything unclassified is red, naming its module. A credential access seeds the binding
// walk of rounds 5 and 6 (credential-walk.fixture.ts), beside the primitives a secret is checked
// with, and every module the walk reaches is named below in exactly one list.
//
// What the walk does not read, exactly:
//   - a value whose static type is no carrier and that no typed flow reached from one: what a
//     package parses out of a carrier handed to it (the MCP transport's tool arguments, ws frames
//     after handleUpgrade) is one classified whole read at the hand-off, not field by field;
//   - what a module does with a value after reading it: an input classified plain and compared by
//     hand with a secret is misclassified, and the classification is the claim a reviewer checks;
//   - a module handed a credential string by a door and checking it by hand, through no seed: the
//     door that read it is named, the checker is not;
//   - a field nested inside a validated object: it is classified under its top-level field;
//   - bytes on an upgraded socket after the handshake (a Duplex is not a carrier);
//   - code outside core's src, and test and fixture files.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanAccesses } from './credential-access.fixture.js';
import type { Access } from './credential-ast.fixture.js';
import {
  CREDENTIAL_INPUTS,
  CREDENTIAL_READS,
  FRAMEWORK_IMPORTS,
  PLAIN_INPUTS,
  PLAIN_READS,
  SURFACE,
} from './credential-inputs.fixture.js';
import { readDoors } from './credential-walk.fixture.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a presented secret is checked with, by the package exporting it. */
const PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  argon2: ['verify'],
  jose: ['jwtVerify', 'jwtDecrypt', 'compactVerify', 'flattenedVerify', 'generalVerify'],
  'hono/jwt': ['verify'],
  'node:crypto': ['timingSafeEqual', 'verify', 'createVerify'],
  crypto: ['timingSafeEqual', 'verify', 'createVerify'],
};

/** Core's own digests a presented secret is looked up by. */
const CORE_SEEDS: Readonly<Record<string, readonly string[]>> = {
  'lib/token-digest.ts': ['digestToken'],
  'shares/token.ts': ['hashShareToken'],
};

/** Each module a chat credential can be presented at, and what it meets there. */
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
  'auth/register.ts':
    'sign-up takes an email and a new password and stores its hash; a chat credential is neither',
  'auth/oauth/routes.ts':
    'the OAuth callback hands the provider’s code and state to handleCallback; a PAT is neither',
};

/**
 * Each module another secret is presented at, looked up its own way, and why a PAT never matches.
 * Each is a door R2 found unnamed, or one the default-deny scan found beside them.
 */
const SECRET_DOORS: Readonly<Record<string, string>> = {
  'lib/hmac.ts':
    'checks a provider’s body signature or shared webhook token; a chat credential is neither',
  'integration-door/webhook-inbound-routes.ts':
    'a webhook verified against its binding’s secret; a chat credential in that header verifies as nothing',
  'integrations/github/connect.ts':
    'verifyConnectState checks an HMAC-signed connect state, which a PAT never is',
  'integration-door/github-connect-routes.ts':
    'the GitHub callbacks check their connect state behind requireAuth, where the chat write rule runs',
  'integrations/identity/github.ts':
    'exchanges GitHub’s code at its token endpoint; a PAT is no OAuth code',
  'integrations/identity/oidc.ts':
    'exchanges the provider’s code at its token endpoint; a PAT is no OAuth code',
  'devices/login-routes.ts':
    'GET /login/poll answers a box credential, with no session, to whoever holds a pairing code core minted for that login and looks up by digest; a PAT is never one. Approving a code sits behind requireAuth, where the chat write rule runs',
  'lib/token-digest.ts':
    'defines digestToken, the SHA-256 a pairing code, an invitation or a verification token is looked up by',
  'lib/invitation.ts': 'invitationDigest digests an invitation token for its lookup',
  'orgs/invitations-routes.ts':
    'GET /:token reads an org invitation by its token, with no session; accepting sits behind requireAuth',
  'projects/invitations-routes.ts':
    'GET /:token reads a project invitation by its token, with no session; accepting sits behind requireAuth',
  'orgs/read.ts': 'orgInvitationByToken looks an org invitation up by its token’s digest',
  'projects/read.ts':
    'projectInvitationByToken looks a project invitation up by its token’s digest',
  'orgs/invitations.ts':
    'issues an org invitation token, storing its digest, and consumes it by that digest',
  'projects/invitation-token.ts':
    'issues a project invitation token, storing its digest, and consumes it by that digest',
  'orgs/service.ts': 'declineOrgInvitation finds the invitation by its token’s digest',
  'projects/service.ts': 'declineProjectInvitation finds the invitation by its token’s digest',
  'auth/verify.ts':
    'GET /verify consumes an email verification token from the query, with no session',
  'auth/verification-token.ts':
    'issues a verification token, storing its digest, and consumes it by that digest',
  'shares/routes.ts':
    'POST /open opens one share for whoever holds its token, with no session; a PAT is never a share token',
  'shares/service.ts': 'openShare looks a share up by its token’s SHA-256',
  'shares/token.ts': 'defines hashShareToken, the SHA-256 a share token is looked up by',
  'integration-door/mcp-relay-routes.ts':
    'the storefront MCP relay admits only the relay ticket core minted for one binding, read by readRelayTicket; a PAT verifies as none',
  'integrations/mcp-relay.ts':
    'readRelayTicket verifies a relay ticket, a JWT under its own issuer naming one binding; a PAT is never one',
  'uploads/routes.ts':
    'an upload or download ticket, a uuid core minted for one file, is the only authority there; a PAT is never one',
};

/** Each module the walk reaches that admits nobody, and why. */
const ADMITS_NOTHING: Readonly<Record<string, string>> = {
  'orgs/routes.ts': 'issues an org invitation token behind requireAuth; it checks none',
  'projects/members-routes.ts':
    'issues a project invitation token behind requireAuth; it checks none',
  'shares/forge-link.ts': 'publishes a share, minting its token; it checks none',
  'root-routes.ts': 'GET /pair passes a pairing code on to the web app’s pair page unread',
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

const plainInputs = new Set(Object.values(PLAIN_INPUTS).flat());
const plainReads = new Set(Object.values(PLAIN_READS).flat());
const isSeed = (a: Access) =>
  a.kind === 'input' ? a.key in CREDENTIAL_INPUTS : a.kind === 'whole' && a.key in CREDENTIAL_READS;
const frameworkSeeds: Record<string, string[]> = {};
for (const [key, entry] of Object.entries(FRAMEWORK_IMPORTS)) {
  const [spec = '', name = ''] = key.split(/:(?=[^:]*$)/);
  if (entry.credential) frameworkSeeds[spec] = [...(frameworkSeeds[spec] ?? []), name];
}

const scan = scanAccesses(SRC, SURFACE);
const all = [...scan.accesses].flatMap(([mod, list]) => list.map((a) => ({ mod, ...a })));
const read = readDoors({
  files: scan.files,
  accesses: scan.accesses,
  isSeed,
  primitives: { ...PRIMITIVES, ...frameworkSeeds },
  coreSeeds: CORE_SEEDS,
  gates: GATES,
});

describe('every door a credential is admitted at is named, with what a chat credential meets there', () => {
  it('reads every request access by type, and refuses none', () => {
    expect(all.filter((a) => a.kind === 'refused').map((a) => a.key)).toEqual([]);
  });

  it('classifies every input read by name, naming the module that reads it', () => {
    const unclassified = all
      .filter((a) => a.kind === 'input' && !(a.key in CREDENTIAL_INPUTS) && !plainInputs.has(a.key))
      .map((a) => `${a.mod} reads ${a.key}`);
    expect([...new Set(unclassified)].sort()).toEqual([]);
  });

  it('classifies every whole read', () => {
    const unclassified = all
      .filter((a) => a.kind === 'whole' && !(a.key in CREDENTIAL_READS) && !plainReads.has(a.key))
      .map((a) => a.key);
    expect([...new Set(unclassified)].sort()).toEqual([]);
  });

  it('classifies each input and read once, and none that core does not make', () => {
    const seen = new Set(all.map((a) => a.key));
    const listed = [
      ...Object.keys(CREDENTIAL_INPUTS),
      ...plainInputs,
      ...Object.keys(CREDENTIAL_READS),
      ...plainReads,
    ];
    expect(listed.filter((k) => !seen.has(k))).toEqual([]);
    expect(listed.filter((k, i) => listed.indexOf(k) !== i)).toEqual([]);
  });

  it('lists every hono, hono/* and @hono/* import as reading a credential or not', () => {
    const imports = [...scan.frameworkImports].flatMap(([mod, list]) =>
      list.map((i) => ({ mod, key: i.key })),
    );
    const unlisted = imports.filter((i) => !(i.key in FRAMEWORK_IMPORTS));
    expect(unlisted.map((i) => `${i.mod} imports ${i.key}`).sort()).toEqual([]);
    const used = new Set(imports.map((i) => i.key));
    expect(Object.keys(FRAMEWORK_IMPORTS).filter((k) => !used.has(k))).toEqual([]);
  });

  it('names every module a credential reaches in exactly one list', () => {
    const lists = [DOORS, SECRET_DOORS, ADMITS_NOTHING].flatMap((l) => Object.keys(l));
    expect(read.doors).toEqual([...lists].sort());
    expect(lists.filter((k, i) => lists.indexOf(k) !== i)).toEqual([]);
  });

  it('hands no check primitive to another module as a value, where no walk can follow it', () => {
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
