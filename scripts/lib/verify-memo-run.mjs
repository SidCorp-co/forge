// The memo as `verify` drives it: ask before a check runs, file after it passed. What it decides is
// only whether a stored verdict may stand in for a run; the verdict itself is always read off the
// output by verify's own rule, whether that output came from a process or from the store.

import { INPUTS } from './check-inputs.mjs';
import {
  audit,
  bypassReason,
  keyFor,
  listEntries,
  lookup,
  readTrace,
  store,
  storeBudget,
  storeDir,
  Tree,
  traceEnv,
} from './verify-memo.mjs';
import { externalDeps, externalHolds } from './verify-memo-external.mjs';
import { gitState } from './verify-memo-git.mjs';

const SHOWN = 20;

const shown = (faults) =>
  [
    ...faults.slice(0, SHOWN).map((f) => `  ${f}`),
    ...(faults.length > SHOWN ? [`  … and ${faults.length - SHOWN} more`] : []),
  ].join('\n');

export class Memo {
  /** @param {{ root: string, args: string[], env?: object, baseRef: string, base: string }} o */
  constructor({
    root,
    args,
    env = process.env,
    baseRef,
    base,
    declarations = INPUTS,
    places = {},
  }) {
    this.places = places;
    this.declarations = declarations;
    this.root = root;
    this.env = env;
    this.dir = storeDir(env);
    this.budget = storeBudget(env);
    this.bypass = bypassReason(args, env);
    this.tree = new Tree(root);
    this.git = gitState(root, baseRef, base);
    this.served = [];
    this.filed = [];
    this.unfiled = [];
    this.uncached = [];
  }

  /** What to do with `check` before it runs: serve a stored verdict, run it traced, or just run it. */
  plan(check) {
    const decl = this.declarations[check.label];
    if (this.bypass || !decl) return { kind: 'bypass' };
    if (decl.uncached) {
      this.uncached.push({ label: check.label, reason: decl.uncached });
      return { kind: 'uncached' };
    }
    let keyed;
    try {
      keyed = keyFor({ check, decl, tree: this.tree, git: this.git, env: this.env });
    } catch (err) {
      this.unfiled.push({
        label: check.label,
        reason: `its key could not be taken: ${err.message}`,
      });
      return { kind: 'bypass' };
    }
    const entry = lookup(this.dir, keyed.key);
    if (entry && externalHolds(entry.external)) {
      this.served.push(check.label);
      return { kind: 'hit', entry };
    }
    return { kind: 'miss', check, decl, ...keyed, ...traceEnv(this.env) };
  }

  /**
   * After a run of a planned miss: the verdict stands as it came, except that a passed check whose
   * trace read past its declaration is refused by name. Files the verdict only when it passed, the
   * trace held, and the tree did not move while the check ran.
   */
  settle(plan, status, out, verdict) {
    if (plan.kind !== 'miss') return verdict;
    const lines = readTrace(plan.dir);
    if (status !== 0 || verdict.code !== 0 || verdict.condition) return verdict;
    const { check, decl } = plan;
    const outside = externalDeps({ root: this.root, lines, ...this.places });
    const faults = [
      ...audit({ root: this.root, decl, tree: this.tree, lines, git: this.git }),
      ...outside.faults,
    ];
    if (faults.length > 0) return this.refuse(check, verdict, faults);
    if (!lines.some((l) => l[0] === 'R' || l[0] === 'L')) {
      this.unfiled.push({ label: check.label, reason: 'no process of it was traced' });
      return verdict;
    }
    this.tree.refresh();
    const after = keyFor({ check, decl, tree: this.tree, git: this.git, env: this.env });
    if (after.key !== plan.key) {
      this.unfiled.push({ label: check.label, reason: 'a file it reads changed while it ran' });
      return verdict;
    }
    const entry = {
      label: check.label,
      cmd: check.cmd,
      out,
      files: plan.count,
      storedAt: Date.now(),
      external: outside.deps,
      audit: decl.blind ? `traced, blind to ${decl.blind.join(', ')}` : 'traced',
    };
    try {
      const filed = store(this.dir, plan.key, entry, this.budget);
      if (filed.refused) this.unfiled.push({ label: check.label, reason: filed.refused });
      else this.filed.push(check.label);
    } catch (err) {
      this.unfiled.push({
        label: check.label,
        reason: `the store refused it: ${err.code ?? err.message}`,
      });
    }
    return verdict;
  }

  refuse(check, verdict, faults) {
    const why = `memo refused: it read past its declared inputs (scripts/lib/check-inputs.mjs)`;
    const out = `${check.label} ${why}:\n${shown(faults)}\n\nName each in its declaration (\`roots\`, \`blind\`), or declare the check \`uncached\` with the reason. Exit 2: a verdict filed under a key that misses a file it read would be served stale, in silence.\n`;
    return { ...verdict, code: 2, why, out };
  }

  /** The lines under the table that say what the memo did. */
  summary() {
    if (this.bypass) return [`  memo: not consulted — ${this.bypass}`];
    const lines = [
      `  memo: ${this.served.length} served from ${this.dir}, ${this.filed.length} run and filed, ${this.unfiled.length + this.uncached.length} run unfiled`,
    ];
    for (const u of this.uncached) lines.push(`    uncached  ${u.label} — ${u.reason}`);
    for (const u of this.unfiled) lines.push(`    unfiled   ${u.label} — ${u.reason}`);
    return lines;
  }
}

/** What the store holds, for `verify --memo`: one line per entry, newest use last, then the bound. */
export function memoListing(env = process.env) {
  const dir = storeDir(env);
  const entries = listEntries(dir, { parse: true });
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  const lines = [
    `verify memo at ${dir}`,
    `  ${entries.length} entries, ${total} of ${storeBudget(env)} bytes`,
  ];
  for (const e of entries) {
    const what = e.entry
      ? `${e.entry.label} · ${e.entry.files} files · ${e.entry.audit}`
      : 'unreadable';
    lines.push(
      `  ${new Date(e.usedAt).toISOString()}  ${String(e.bytes).padStart(7)}  ${e.key.slice(0, 12)}  ${what}`,
    );
  }
  for (const [label, d] of Object.entries(INPUTS).filter(([, d]) => d.uncached)) {
    lines.push(`  uncached by declaration: ${label} — ${d.uncached}`);
  }
  return lines;
}
