import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergePipelineConfig, pipelineConfigSchema } from './pipeline-config-schema.js';
import { QA_JUDGEMENT_KEY, QA_JUDGEMENT_MODES } from './qa-judgement.js';

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The module that is allowed to spell them, and this file, which quotes them to check. */
const SPELLERS = new Set(['pipeline/qa-judgement.ts', 'pipeline/qa-judgement.test.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Comments are stripped first: this repo writes obituaries, and every guard explaining the key
 *  names it. Scanning raw source would report the explanation as the defect. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the qa judgement key is spelled in exactly one place', () => {
  it('is what the plugin matches against', () => {
    expect(QA_JUDGEMENT_KEY).toBe('qa');
    expect([...QA_JUDGEMENT_MODES]).toEqual(['independent', 'builder']);
  });

  it('is spelled nowhere else in this package', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (SPELLERS.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));

      // The key read off a pipelineConfig document by hand, rather than through the constant.
      if (/pipelineConfig\s*(?:\.qa\b|\[\s*['"]qa['"]\s*\])/.test(code)) {
        offenders.push(`${rel} — reads the \`qa\` key literally`);
      }

      // A mode spelled out. Scoped to files that are ALSO about this key, because both words are
      // ordinary English and appear across the repo for unrelated reasons — a repo-wide ban on the
      // string would be a gate nobody could keep green, and a gate nobody can keep green gets
      // waived rather than obeyed.
      const aboutThisKey = /QA_JUDGEMENT_|pipelineConfig[\s\S]{0,40}qa\b/.test(code);
      if (!aboutThisKey) continue;
      for (const mode of QA_JUDGEMENT_MODES) {
        if (new RegExp(`['"]${mode}['"]`).test(code)) {
          offenders.push(`${rel} — spells the mode '${mode}'`);
        }
      }
    }
    expect(
      offenders,
      `spell these through QA_JUDGEMENT_KEY / QA_JUDGEMENT_MODES:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('pipelineConfig stores the qa judgement, and refuses anything else', () => {
  it('keeps a declared mode through a parse', () => {
    for (const mode of QA_JUDGEMENT_MODES) {
      const out = pipelineConfigSchema.parse({ [QA_JUDGEMENT_KEY]: mode }) as Record<
        string,
        unknown
      >;
      expect(out[QA_JUDGEMENT_KEY], mode).toBe(mode);
    }
  });

  it('refuses a value that names neither mode', () => {
    const bad = pipelineConfigSchema.safeParse({ [QA_JUDGEMENT_KEY]: 'reviewer' });
    expect(bad.success).toBe(false);
  });

  it('stores a mode onto an existing document and returns it on the next read', () => {
    const stored = { enabled: true, maxResumeTokens: 150_000 };
    const merged = mergePipelineConfig(stored, { [QA_JUDGEMENT_KEY]: 'independent' }) as Record<
      string,
      unknown
    >;
    expect(merged[QA_JUDGEMENT_KEY]).toBe('independent');
    // and the neighbours it was merged onto are still there
    expect(merged.enabled).toBe(true);
    expect(merged.maxResumeTokens).toBe(150_000);

    const reread = pipelineConfigSchema.parse(merged) as Record<string, unknown>;
    expect(reread[QA_JUDGEMENT_KEY]).toBe('independent');
  });
});
