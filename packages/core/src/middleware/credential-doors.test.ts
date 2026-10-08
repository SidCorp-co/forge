// Every door a bearer credential is admitted at, and what a chat credential meets there (REQ-30 BC-4,
// ISS-439 round 4). The round 3 judge found an Agent session's turn token admitted as its box on
// every route gated requireUserOrDevice(), where the chat write rule never ran. A chat credential
// is a token core minted for a chat — an Agent session's turn token, the Assistant's turn token, an
// agreed proposal's token — and every one is a PAT, so it is never a session JWT, and the one rule
// has to run wherever a PAT is admitted. This list is closed against the source: a module that
// verifies a credential and is not named here turns the test red, so a door added later is read
// before it serves. The integration suite (`tests/integration/chat-agreement-default-e2e.test.ts`)
// presents a real turn token at each door.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each module that verifies a presented credential, and what a chat credential meets in it. */
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
};

const VERIFIES =
  /\b(verifyPat|authenticatePat|readBoxToken|verifyDeviceToken|verifyDeviceCredential|verifyUserToken|beginPatRequest)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('every door a credential is admitted at is named, with what a chat credential meets there', () => {
  it('names exactly the modules that verify a presented credential', () => {
    const found = sources(SRC)
      .filter((path) => VERIFIES.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .sort();
    expect(found).toEqual(Object.keys(DOORS).sort());
  });

  it('/mcp asks the chat write rule before a tool runs', () => {
    const mcp = readFileSync(join(SRC, 'mcp/server.ts'), 'utf8');
    expect(mcp).toMatch(/await chatToolWriteRefusal\(name, args,/);
  });

  it('the only PAT admission on the REST plane runs the chat write rule', () => {
    const auth = readFileSync(join(SRC, 'middleware/auth.ts'), 'utf8');
    const admitPat = auth.slice(auth.indexOf('async function admitPat('));
    expect(admitPat.slice(0, admitPat.indexOf('\n}\n'))).toContain('await admitChatWrite(c);');
    const callers = sources(SRC).filter((p) => /\bbeginPatRequest\(/.test(readFileSync(p, 'utf8')));
    expect(callers.map((p) => relative(SRC, p)).sort()).toEqual([
      'middleware/auth.ts',
      'middleware/pat-rest-surface.ts',
    ]);
  });
});
