// The kernel write does not know a chat channel exists, and it stays that way.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(here, f), 'utf8') }));

describe('questions/ imports nothing from integrations/', () => {
  it('reads at least the modules this rule is about', () => {
    // cm:guard the scan proves it scanned something: a glob that matched nothing would pass every assertion below while checking no file at all.
    expect(sources.map((s) => s.file).sort()).toEqual(
      expect.arrayContaining(['protections.ts', 'read.ts', 'routes.ts', 'stop.ts', 'write.ts']),
    );
  });

  it('names no integrations module in any import', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/^\s*import[^;]*?from\s+'([^']+)';/gm)]
        .map((m) => m[1] as string)
        .filter((spec) => /(^|\/)integrations\//.test(spec))
        .map((spec) => `${file} -> ${spec}`),
    );
    // cm:guard a down bot, a missing binding or a chat outage must never fail or slow the kernel write that records a park, and an import is the first step toward one doing so (ISS-978 criterion 4).
    expect(offenders).toEqual([]);
  });

  it('names no rocketchat module by any other route either', () => {
    const offenders = sources
      .filter(({ text }) => /rocketchat|rocket-chat/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
