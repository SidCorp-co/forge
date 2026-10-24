// @direct-test-of packages/contracts/src/permissions.ts
// @direct-test-of packages/contracts/src/said.ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_ROLE_LABELS, PERMISSIONS } from '@forge/contracts/permissions';
import { say, sayEn } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';

// A standing that waits on a permission's holder names the role that holds it, never the permission
// id (ISS-605: the failed onboarding line read "A holder of onboarding.request"). Every permission core
// passes to `standing.who.holderOf` is found in its source and read here, so one added without a
// role is red by name.

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every permission core's source passes to `standing.who.holderOf`, with the file that passes it. */
function holderPerms(): { perm: string; file: string }[] {
  const pattern = /say\(\s*['"]standing\.who\.holderOf['"]\s*,\s*\{\s*perm:\s*['"]([^'"]+)['"]/g;
  return sourcesUnder(src).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => ({
      perm: m[1] as string,
      file: file.slice(src.length + 1),
    })),
  );
}

describe("a permission's holder, as a standing names them", () => {
  it('finds the holders core names, the failed onboarding line among them', () => {
    const found = holderPerms();
    expect(found.length).toBeGreaterThan(5);
    expect(found).toContainEqual({ perm: 'onboarding.request', file: 'onboarding/hint.ts' });
    expect(found).toContainEqual({ perm: 'feedback.approve', file: 'feedback/standing.ts' });
  });

  it('reads every permission core passes to holderOf as its role, never the permission id', () => {
    const wrong = holderPerms().flatMap(({ perm, file }) => {
      const role = (PERMISSION_ROLE_LABELS as Record<string, string | undefined>)[perm];
      if (!role) return [`${file}: ${perm} has no role in PERMISSION_ROLE_LABELS`];
      const en = sayEn(say('standing.who.holderOf', { perm }));
      return en === role && !en.includes(perm) ? [] : [`${file}: ${perm} reads "${en}"`];
    });
    expect(wrong).toEqual([]);
  });

  it('gives every permission a role of one to three words', () => {
    const wrong = PERMISSIONS.filter((p) => {
      const role = (PERMISSION_ROLE_LABELS as Record<string, string | undefined>)[p];
      return !role || role.includes('.') || role.split(' ').length > 3;
    });
    expect(wrong).toEqual([]);
  });

  it('refuses a permission with no role by name where the sentence is built, never rendering it', () => {
    expect(() => say('standing.who.holderOf', { perm: 'onboarding.nosuch' })).toThrow(
      /SAID_VAR_KIND: "standing.who.holderOf" \{perm\} must be a permission with a role/,
    );
  });
});
