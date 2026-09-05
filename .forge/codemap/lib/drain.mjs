// @generated codemap 0.16.0 — vendored by `cm install`; edit the plugin, not this.
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

import { diag } from './parse.mjs';
import { blobAt } from './registry.mjs';
import { analyzeFile } from './analyze.mjs';

/** How much of `frozen` this analysis still carries. */
// cm:guard `cm verify`'s debt line and this rule MUST count the same way — a rule that disagreed
//   with the number printed beside it would demand a payment the report says was already made
// cm:guard ISS-21's blockAlive coarsening is part of the count: a reflow moves no words, so the
//   frozen keys of a rewrapped block are still debt
export function debtOf(frozen, res) {
  if (!frozen?.size) return 0;
  const present = new Set(res.presentKeys ?? res.proseKeys ?? []);
  const blockAlive = (res.blockKeys ?? []).some((b) => frozen.has(b));
  let n = 0;
  for (const k of frozen) {
    if (k.startsWith('b:')) continue;
    if (present.has(k) || blockAlive) n++;
  }
  return n;
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
