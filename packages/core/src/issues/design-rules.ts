/**
 * The design rules (REQ-36 BC-1, BC-2, BC-13; Issue lifecycle r15 `design-check`), pure over what
 * `design-record.ts` read: what a design write is refused with, and whether the issue's design
 * passes the check every move into build asks. A criterion's pattern holds where the project's
 * catalog has it, or where the issue named it as new and its reviewer approved it; a project that
 * reads no catalog names none.
 */

import {
  type CriterionClass,
  DESIGN_RECORD_INCOMPLETE,
  DESIGN_RECORD_MISSING,
  type DesignCheck,
  type IssueDesignRefusal,
  type RecordDesignRequest,
} from '@forge/contracts/issue-design';
import type { CatalogReading, PatternRowFacts } from './pattern-rules.js';

export interface LiveCriterion {
  id: string;
  n: number;
  statement: string;
}

export interface DesignLine {
  criterionId: string;
  criterionClass: CriterionClass;
  pattern: string | null;
  proof: string;
}

export interface DesignFacts {
  issueRef: string;
  catalog: CatalogReading;
  criteria: readonly LiveCriterion[];
  /** The issue's pattern rows, which say which new patterns were approved. */
  patterns: readonly PatternRowFacts[];
  /** The recorded design, or null; `modules` are label ids. */
  design: { modules: readonly string[]; lines: readonly DesignLine[] } | null;
  /** The project's module label ids as they stand. */
  moduleIds: ReadonlySet<string>;
}

const refusal = (
  code: IssueDesignRefusal['code'],
  detail: string,
  path: string,
): IssueDesignRefusal => ({ code, detail, path });

/** A new pattern the issue named and its reviewer approved, not retracted since. */
function approvedNew(slug: string, patterns: readonly PatternRowFacts[]): boolean {
  return patterns.some(
    (p) => p.pattern === slug && p.kind === 'new' && p.decision === 'approved' && !p.retractedAt,
  );
}

/** Why `pattern` does not hold for criterion `n`, or null. */
function patternFault(
  n: number,
  pattern: string | null,
  facts: Pick<DesignFacts, 'catalog' | 'patterns' | 'issueRef'>,
): { code: IssueDesignRefusal['code']; detail: string } | null {
  const { catalog } = facts;
  if (catalog.kind === 'undeclared') {
    return pattern === null
      ? null
      : {
          code: 'DESIGN_PATTERN_UNDECLARED',
          detail: `criterion ${n} names pattern \`${pattern}\`, and ${catalog.detail}; send \`pattern: null\``,
        };
  }
  if (pattern === null) {
    return {
      code: 'DESIGN_PATTERN_REQUIRED',
      detail: `criterion ${n} names no pattern; name a catalog entry (docs/patterns/<slug>.md) or a new pattern approved on ${facts.issueRef}`,
    };
  }
  if (catalog.slugs.has(pattern) || approvedNew(pattern, facts.patterns)) return null;
  return {
    code: 'DESIGN_PATTERN_UNCATALOGUED',
    detail: `criterion ${n} names pattern \`${pattern}\`, which is not in the catalog (${[...catalog.slugs].join(', ')}) and has no recorded approval as a new pattern on ${facts.issueRef}. Name a catalogued one, or name it as new (POST /api/issues/:id/patterns) and record the design once its reviewer approves it`,
  };
}

/** What a design write is refused with, in the order the body reads; empty where it may be recorded. */
export function designWriteRefusals(
  body: RecordDesignRequest,
  facts: Pick<DesignFacts, 'catalog' | 'patterns' | 'issueRef' | 'criteria'>,
): IssueDesignRefusal[] {
  const out: IssueDesignRefusal[] = [];
  const live = new Map(facts.criteria.map((c) => [c.n, c]));
  const seen = new Set<number>();
  for (const [at, line] of body.criteria.entries()) {
    const path = `/criteria/${at}`;
    if (!live.has(line.criterion)) {
      out.push(
        refusal(
          'DESIGN_CRITERION_UNKNOWN',
          `${facts.issueRef} has no criterion ${line.criterion}; its criteria are ${facts.criteria.length === 0 ? 'none: write them first' : facts.criteria.map((c) => c.n).join(', ')}`,
          `${path}/criterion`,
        ),
      );
      continue;
    }
    if (seen.has(line.criterion)) {
      out.push(
        refusal(
          'DESIGN_CRITERION_REPEATED',
          `criterion ${line.criterion} is designed twice; send one line per criterion`,
          `${path}/criterion`,
        ),
      );
      continue;
    }
    seen.add(line.criterion);
    const fault = patternFault(line.criterion, line.pattern, facts);
    if (fault) out.push(refusal(fault.code, fault.detail, `${path}/pattern`));
  }
  const left = facts.criteria.filter((c) => !seen.has(c.n)).map((c) => c.n);
  if (left.length > 0) {
    out.push(
      refusal(
        'DESIGN_CRITERION_LEFT_OUT',
        `the design leaves out criterion ${left.join(', ')} of ${facts.issueRef}; every criterion names its class, pattern and proof`,
        '/criteria',
      ),
    );
  }
  return out;
}

/** The design check as the issue stands: every part named and still holding, or each gap named. */
export function designCheck(facts: DesignFacts): DesignCheck {
  if (facts.design === null) {
    return {
      passed: false,
      code: DESIGN_RECORD_MISSING,
      missing: ['design'],
      detail: `${facts.issueRef} has no design. Record it (PUT /api/issues/:id/design), then move it.`,
    };
  }
  const lines = new Map(facts.design.lines.map((l) => [l.criterionId, l]));
  const missing: string[] = [];
  if (facts.criteria.length === 0) missing.push('criteria: the issue has none');
  for (const c of facts.criteria) {
    const line = lines.get(c.id);
    if (!line) {
      missing.push(`criterion ${c.n}: no class, pattern or proof (written or reworded since)`);
      continue;
    }
    const fault = patternFault(c.n, line.pattern, facts);
    if (fault) missing.push(`criterion ${c.n}: ${fault.code}`);
  }
  const gone = facts.design.modules.filter((m) => !facts.moduleIds.has(m));
  if (facts.design.modules.length === 0) missing.push('modules: none named');
  for (const m of gone) missing.push(`module ${m}: no longer a module of the project`);
  if (missing.length === 0) return { passed: true };
  return {
    passed: false,
    code: DESIGN_RECORD_INCOMPLETE,
    missing,
    detail: `The design of ${facts.issueRef} lacks ${missing.join('; ')}. Record it again (PUT /api/issues/:id/design), then move it.`,
  };
}
