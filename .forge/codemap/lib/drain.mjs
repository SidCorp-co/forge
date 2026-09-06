// @generated codemap 0.16.1 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 §8 — CM013, the second path by which the baseline reduces.
//
// The first is siting: prose sharing a block with a cm: annotation is reported regardless of the
// baseline, because annotating a site means you have just read it. That is the whole of it, and it
// fires only when an author reaches for a tag — so a file with frozen debt could be refactored,
// extended and rewritten for years with its frozen count never moving. Debt that is never touched
// by the work that touches its file is debt that never leaves.
//
// So this asks what siting cannot: you are already editing this file, why is its frozen count
// still the same?
//
// What it must NOT bill, each falling out of the rule rather than out of an exception list:
//   - a reflow, rewrap, reindent or repo-wide formatter run — `codeShape` is identical on both
//     sides and the rule needs a CODE edit. Billing a `fmt` run for every file it touched is how
//     a gate gets switched off.
//   - a file move — the new path has no baseline entry, so there is no debt to drain.
//   - deleting or rewording a frozen comment — the debt fell, which is the rule satisfied.
//   - a run with no base revision — "edited" is meaningless without one, and a rule that guessed
//     would bill a file for an edit somebody else made years ago.

import { diag, baselineKey, PROSE_CODES } from './parse.mjs';
import { blobAt } from './registry.mjs';
import { analyzeFile } from './analyze.mjs';

/** How much of `frozen` this analysis still carries. */
// cm:guard `cm verify`'s debt line and this rule MUST count the same way — a rule that disagreed with the number printed beside it would demand a payment the report says was already made; that is why the block credit below is derived from `res` alone, so both call sites can compute it without a base revision.
// cm:guard ISS-21's reflow credit is per BLOCK, never per file: a rewrapped block keeps its block key while every line key under it changes, so it stands in for the frozen prose it still holds and is charged once. It was `blockKeys.some(...)` OR'd into every key until 2026-09-05, which charged a file's whole frozen count while ANY of its blocks survived — measured on packages/core/src/skills/builtin-seed.ts: deleting 1 of 19 frozen comments left the debt at 19, deleting 4 left 19, and only deleting all 19 paid. A debt that cannot fall by one is not a debt, it is a wall, and eleven `cm:ignore CM013` lines went in to get over it.
// cm:hack codemap ISS-9 until:the baseline records how many line keys each `b:` block froze — a block whose frozen keys were all rewrapped is charged 1, not the count it actually held, so rewrapping a 2-comment block alongside a code edit lowers the debt by one and passes the gate. Priced deliberately: the alternative needs the base revision here, which `cm verify`'s debt line does not have, and the guard above forbids the two disagreeing.
export function debtOf(frozen, res) {
  if (!frozen?.size) return 0;
  const present = new Set(res.presentKeys ?? res.proseKeys ?? []);
  let n = 0;
  for (const k of frozen) {
    if (k.startsWith('b:')) continue;
    if (present.has(k)) n++;
  }
  for (const b of res.blockKeys ?? []) {
    if (!frozen.has(b)) continue;
    if (!keysUnder(res, b).some((k) => frozen.has(k))) n++;
  }
  return n;
}

/** The line keys this analysis currently sees under one block. */
function keysUnder(res, blockKey) {
  return (res.diags ?? [])
    .filter((d) => d.blockKey === blockKey && PROSE_CODES.has(d.code))
    .map((d) => baselineKey(d.text ?? d.message));
}

/** The base revision this run measures against, or null when it has no notion of "edited". */
// cm:guard null must mean "do not ask", never "ask against HEAD" — a whole-tree run compared to
//   HEAD would demand a re-freeze of every file in the repo that carries debt, which is not a gate
// cm:guard the mid-edit hook is deliberately NOT an enforcement point: it runs `--changed-lines`
//   with no base ref, so this returns null there and nothing fires
// cm:why stopping an agent mid-keystroke to demand unrelated cleanup is the mistake
//   hook-post-edit.mjs records paying once — the unit here is a CHANGE, so a commit is the moment
export function drainBase({ since, staged }) {
  if (since) return since;
  return staged ? 'HEAD' : null;
}

/**
 * CM013 for every file in `perFile` whose code changed since `baseRef` without its frozen debt
 * falling.
 *
 * @param perFile analyses of the WORKING TREE, as verify already computed them — re-analyzing here
 *   would let the two sides of the comparison drift apart.
 */
export function drainDiags({ root, reg, baseline, perFile, baseRef }) {
  if (!baseRef || reg.enforce?.drain === false) return [];
  const out = [];

  for (const f of perFile) {
    const frozen = baseline[f.relPath];
    if (!frozen?.size) continue;

    const after = debtOf(frozen, f);
    if (!after) continue;

    const baseSrc = blobAt(root, baseRef, f.relPath);
    // cm:why a file that did not exist at the base revision never carried debt there, so nothing about
    //   it can have failed to fall — this is what makes a file MOVE free without naming renames
    if (baseSrc === null) continue;

    const before = analyzeFile({ relPath: f.relPath, src: baseSrc, reg, frozen });
    // cm:guard both sides must have a shape, or "unchanged" is indistinguishable from "unanswerable" —
    //   a skipped or generated file has neither, and is not enforced anywhere else either
    if (!before.codeShape || !f.codeShape || before.codeShape === f.codeShape) continue;
    if (after < debtOf(frozen, before)) continue;

    // cm:guard the anchor is frozen prose, so it is by construction a line the diff did NOT touch —
    //   `fileLevel` is what keeps inScope() from filtering the diagnostic to death (see cm.mjs)
    const anchor = f.diags.find((d) => d.blockKey && frozen.has(d.blockKey))
      ?? f.diags.find((d) => d.code === 'CM001' || d.code === 'CM010');
    // cm:guard the ignore is honoured from ANYWHERE in the file, unlike every other code
    // cm:why the verdict is on the FILE and its anchor moves as the prose above it does, so an
    //   escape hatch pinned to a line nobody can predict would not be one
    if ([...(f.ignores?.values() ?? [])].some((codes) => codes.has('CM013'))) continue;

    out.push({
      ...diag('CM013', f.relPath, anchor?.line ?? 1, `${after} still frozen, unchanged by this edit`),
      fileLevel: true,
    });
  }

  return out;
}
