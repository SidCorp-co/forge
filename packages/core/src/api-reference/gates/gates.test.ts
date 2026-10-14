import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refusalsOf } from '../../middleware/declarations.js';
import { PAT_DOOR_REFUSALS } from '../../middleware/pat-rest-surface.js';

/**
 * The refusals a gate declares are the ones its source throws. A gate is read from its declaration
 * by the API reference, so a code thrown and never declared would be an error no reference lists.
 */
const MIDDLEWARE = (file: string) =>
  fileURLToPath(new URL(`../../middleware/${file}`, import.meta.url));

const read = (file: string) => readFileSync(MIDDLEWARE(file), 'utf8');

/** Each error code a file's source writes: `code: 'X'` in a cause, or the first argument of `unauth('X', …)`. */
function codesWritten(text: string): string[] {
  const named = [...text.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] ?? '');
  const passed = [...text.matchAll(/\bunauth\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] ?? '');
  return [...new Set([...named, ...passed])].sort();
}

async function gates() {
  const [auth, fresh, admin, device, anyAuth, user, apiKey, limit] = await Promise.all([
    import('../../middleware/auth.js'),
    import('../../middleware/require-fresh-auth.js'),
    import('../../middleware/require-admin.js'),
    import('../../middleware/require-device.js'),
    import('../../middleware/require-any-auth.js'),
    import('../../middleware/require-user.js'),
    import('../../middleware/api-key.js'),
    import('../../middleware/rate-limit.js'),
  ]);
  const declared = (...built: object[]) =>
    [...new Set(built.flatMap((gate) => refusalsOf(gate).map((r) => r.code)))].sort();
  return {
    'auth.ts': declared(auth.requireAuth(), auth.requireUserOrDevice(), auth.assertEmailVerified()),
    'require-fresh-auth.ts': declared(fresh.requireFreshAuth()),
    'require-admin.ts': declared(admin.requireAdmin()),
    'require-device.ts': declared(device.requireDevice()),
    'require-any-auth.ts': declared(anyAuth.requireAnyAuth()),
    'require-user.ts': declared(user.requireUser()),
    'api-key.ts': declared(apiKey.requireProjectApiKey()),
    'rate-limit.ts': declared(limit.rateLimit({ max: 1, windowMs: 1, by: 'ip' } as never)),
  } as Record<string, string[]>;
}

describe('every gate declares what its source throws', () => {
  it('declares, for each gate module, exactly the codes the module writes', async () => {
    const declared = await gates();
    const mismatched = Object.entries(declared).flatMap(([file, codes]) => {
      const written = codesWritten(read(file));
      const undeclared = written.filter((c) => !codes.includes(c));
      const unthrown = codes.filter((c) => !written.includes(c));
      return [
        ...undeclared.map((c) => `${file} throws ${c} and declares no refusal for it`),
        ...unthrown.map((c) => `${file} declares ${c} and its source never writes it`),
      ];
    });
    expect(mismatched).toEqual([]);
  });
});

describe('the PAT door table is the door', () => {
  // assertMayMintFullCredential lives in the door's file and is called by the routes that mint a
  // credential, which declare its code themselves.
  const routeOwned = ['PAT_MINT_NEEDS_FULL_GRANT'];

  it('declares each code the door file throws, and the rate limit authenticatePat throws', () => {
    // The table itself writes every code once; what the door throws is the file without it.
    const withoutTable = read('pat-rest-surface.ts').replace(
      /export const PAT_DOOR_REFUSALS[\s\S]*?\]\);/,
      '',
    );
    const throws = codesWritten(withoutTable).filter((c) => !routeOwned.includes(c));
    const declared = PAT_DOOR_REFUSALS.map((r) => r.code).filter((c) => c !== 'RATE_LIMITED');
    expect(declared.sort()).toEqual(throws.sort());
    expect(codesWritten(read('require-pat.ts'))).toContain('RATE_LIMITED');
  });

  it('lists each status and code once and says when each happens', () => {
    const pairs = PAT_DOOR_REFUSALS.map((r) => `${r.status} ${r.code}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(PAT_DOOR_REFUSALS.filter((r) => r.when.length < 10)).toEqual([]);
  });
});
