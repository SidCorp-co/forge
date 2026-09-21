import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentSessionKinds } from '../db/schema.js';
import {
  AGENT_SESSION_KIND_LIST,
  CLIENT_SESSION_KINDS,
  isAgentSessionKind,
  kindTuple,
  NON_CLIENT_SESSION_KINDS,
} from './session-kinds.js';

const SRC = resolve(fileURLToPath(new URL('../', import.meta.url)));

/**
 * The one file allowed to read `metadata.type`: `assertAgentChatOwner` guards a
 * flag a CLIENT put there, not a species core wrote. No writer sets
 * `type: 'agent'` and the create route refuses a caller that tries, so the
 * guard is reachable only by older rows — deleting it widens read access there.
 */
const PRIVACY_FLAG_READER = 'agent-sessions/session-access.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('a session says its own species', () => {
  it('has no query left that reads a session kind out of metadata', () => {
    const offences: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (/metadata\s*(\}\s*)?->>\s*'type'/.test(line)) {
          offences.push(`${rel}:${i + 1} reads a species out of metadata->>'type'`);
        }
        if (rel !== PRIVACY_FLAG_READER && /metadata\s+as\s*\{\s*type\??:/.test(line)) {
          offences.push(`${rel}:${i + 1} casts metadata to read a \`type\``);
        }
      }
    }
    expect(
      offences,
      `A session's species is the \`agent_sessions.kind\` column (${AGENT_SESSION_KIND_LIST}). It was a jsonb key that two of five writers forgot, so a sweep filtering on it silently skipped them (ISS-1136). Ask the row.`,
    ).toEqual([]);
  });

  it('builds its SQL tuples from the column vocabulary rather than a copy', () => {
    for (const kind of NON_CLIENT_SESSION_KINDS) {
      expect(agentSessionKinds).toContain(kind);
    }
    for (const kind of CLIENT_SESSION_KINDS) {
      expect(agentSessionKinds).toContain(kind);
    }
    // Between them the two sets are the whole vocabulary: the sweeps' "not a
    // client" arm is a NOT over one of them, so a kind in neither would be
    // invisible to both arms at once.
    expect([...NON_CLIENT_SESSION_KINDS, ...CLIENT_SESSION_KINDS].sort()).toEqual(
      [...agentSessionKinds].sort(),
    );
  });

  it('parameterises the tuple instead of interpolating the values', () => {
    const tuple = kindTuple(CLIENT_SESSION_KINDS);
    expect(tuple.queryChunks.length).toBeGreaterThan(0);
    const inlined = JSON.stringify(tuple.queryChunks);
    expect(inlined).not.toContain("'chat'");
  });

  it('refuses a value that is not a kind', () => {
    expect(isAgentSessionKind('master')).toBe(true);
    expect(isAgentSessionKind('chat')).toBe(true);
    // The value the session list route filtered on for two years, which no
    // writer in this repository has ever set.
    expect(isAgentSessionKind('agent')).toBe(false);
    expect(isAgentSessionKind('')).toBe(false);
    expect(isAgentSessionKind(null)).toBe(false);
  });
});
