// What conformance-audit reads off the setup that is not a rule itself: the profiles it can claim,
// the jobs a workflow declares, and the biome rules a config leaves non-blocking.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './gate.mjs';
import { SIZE_RULES } from './lint-budget.mjs';

export const at = (p) => join(ROOT, p);
export const has = (p) => existsSync(at(p));
export const read = (p) => {
  try {
    return readFileSync(at(p), 'utf8');
  } catch {
    return null;
  }
};

export const PROFILES = {
  baseline: { blurb: 'a number you did not have', at1: 1, at2: 0, ci: false, meta: false },
  standard: {
    blurb: 'debt stops growing, gates cannot rot silently',
    at1: 2,
    at2: 2,
    ci: true,
    meta: true,
  },
  hardened: {
    blurb: 'the whole declared surface is defended',
    at1: 4,
    at2: 4,
    ci: true,
    meta: true,
  },
};

/** Every top-level job key under `jobs:` in one workflow's text. */
export function workflowJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) jobs.push(head[1]);
  }
  return jobs;
}

const NON_BLOCKING = new Set(['warn', 'info', 'on']);

/** Every rule a biome config sets to a severity biome exits 0 on, as biome category ids. */
function nonBlockingRules(doc) {
  const out = new Set();
  const walk = (rules) => {
    for (const [group, body] of Object.entries(rules ?? {})) {
      if (group === 'preset' || group === 'recommended') continue;
      if (typeof body === 'string') {
        if (NON_BLOCKING.has(body)) out.add(`lint/${group}/*`);
        continue;
      }
      for (const [name, spec] of Object.entries(body ?? {})) {
        if (NON_BLOCKING.has(typeof spec === 'string' ? spec : spec?.level)) {
          out.add(`lint/${group}/${name}`);
        }
      }
    }
  };
  walk(doc?.linter?.rules);
  for (const o of doc?.overrides ?? []) walk(o?.linter?.rules);
  return out;
}

function biomeConfigs(dir = '', depth = 0, acc = []) {
  if (depth > 3) return acc;
  for (const e of readdirSync(at(dir), { withFileTypes: true })) {
    if (e.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) biomeConfigs(p, depth + 1, acc);
    else if (e.name === 'biome.json') acc.push(p);
  }
  return acc;
}

export function uncountedWarnRules(manifest) {
  const scopesOf = (key) =>
    (manifest?.checkers?.[key]?.scopes ?? []).map((s) => s.cwd).filter(Boolean);
  const lint = scopesOf('lint-budget');
  const size = scopesOf('size-budget');
  const gaps = [];
  for (const cfg of biomeConfigs()) {
    const dir = dirname(cfg) === '.' ? '' : dirname(cfg);
    let doc;
    try {
      doc = JSON.parse(read(cfg) ?? '');
    } catch {
      gaps.push(`${cfg} is unreadable`);
      continue;
    }
    for (const rule of nonBlockingRules(doc)) {
      if (!(SIZE_RULES.has(rule) ? size : lint).includes(dir)) gaps.push(`${dir || '.'} ${rule}`);
    }
  }
  return gaps;
}
