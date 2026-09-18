/**
 * ISS-978 F5 — who may say "this passed".
 *
 * `MessageVerdict`'s `ok` arm is nominal, so the only way to produce one is to
 * cast, and a cast is a file declaring itself a screen. That is a claim this
 * repo has to agree to file by file: before ISS-978 the arm was structural and
 * five reply paths hand-built one, which is why a passing verdict was evidence
 * of nothing at all. This scan is what keeps the sixth from being written
 * quietly — the compiler cannot tell a screen's cast from anybody else's.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Every file this repo has agreed may mint an `ok` verdict, and why.
 */
// cm:guard the third entry is a `cm:hack` and not a screen: `screened-reply.ts` casts to signal
// "not a failure, stop repairing" because `RepairRound.screen` can only answer with a verdict. It is
// bounded — the empty text it stands for reaches `codeAuthored` before it can reach `screened()`, so
// it mints no proof and posts nothing — and it ends when that callback grows a third outcome.
const MAY_MINT = new Map<string, string>([
  ['messaging/screen.ts', 'THE screen: the cell rules run here, and `admitted` is the mint itself'],
  [
    'integrations/rocketchat/comment-carry.ts',
    'a screen too — it reads a carried comment against NO_ROOM_BROADCAST_CARRIED and refuses on what it finds',
  ],
  [
    'conversations/screened-reply.ts',
    'cm:hack ISS-978: a control-flow signal for an empty first reply, which can mint no proof',
  ],
  [
    'messaging/screen-passes.fixture.ts',
    'a TEST fixture: a screen that admits whatever it is shown, listed here rather than excluded by filename because a producer hiding in a `.fixture.ts` is what this scan exists to catch',
  ],
]);

// cm:guard BOTH shapes count as minting: `admitted(...)` is the real mint, and a cast is what a
// file does when it wants an `ok` verdict without going through one. A scan that watched only the cast
// would let a sixth reply path call `admitted` and declare its own text passed.
const MINT_RE = /as\s+(?:unknown\s+as\s+)?MessageVerdict|\badmitted\(/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listSourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full, rel));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('only a screen mints a passing verdict (ISS-978 F5)', () => {
  const minting = listSourceFiles(SRC_ROOT).filter((rel) =>
    MINT_RE.test(stripComments(readFileSync(`${SRC_ROOT}${rel}`, 'utf8'))),
  );

  it('no file outside the agreed list casts its way to an ok verdict', () => {
    expect(
      minting.filter((rel) => !MAY_MINT.has(rel)),
      'A file is asserting that a message passed a screen without being one. Run the screen and pass ' +
        'its verdict on, or add this file here with the reason it is a screen.',
    ).toEqual([]);
  });

  // cm:guard the list is asserted in BOTH directions: an entry for a file that no longer casts is a
  // permission nobody is using, and the next reader takes it as evidence the cast is still needed.
  it('every file on the list is still minting, so the list does not outlive its reasons', () => {
    expect([...MAY_MINT.keys()].filter((rel) => !minting.includes(rel))).toEqual([]);
  });

  it('the scan detects a planted mint (meta-test)', () => {
    expect(MINT_RE.test(stripComments('const v = { ok: true } as MessageVerdict;'))).toBe(true);
    expect(MINT_RE.test(stripComments('const v = x as unknown as MessageVerdict;'))).toBe(true);
    expect(MINT_RE.test(stripComments('// const v = { ok: true } as MessageVerdict;'))).toBe(false);
    expect(MINT_RE.test(stripComments('const v = admitted([text]);'))).toBe(true);
    expect(MINT_RE.test(stripComments('function f(): MessageVerdict { return screen(); }'))).toBe(
      false,
    );
  });
});
