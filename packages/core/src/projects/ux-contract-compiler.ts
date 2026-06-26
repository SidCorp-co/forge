export interface UxContractRuleInput {
  group: string;
  text: string;
  status: string;
  orderIndex: number;
}

/**
 * Project-specific framing the compiler weaves around the rule bullets. Before
 * ISS-578 these were hardcoded to forge-dev/web-v2; they now come from the
 * project's stored `uxContractProfile` so a preset compiles correctly for ANY
 * project/stack. Feed the web-v2 scaffold and the output is byte-identical to
 * the original hand-authored forge-dev contract (golden test guards this).
 */
export interface UxContractScaffold {
  /** Title suffix after "UX Completeness Contract — ", e.g. "web-v2 (forge-dev)". */
  projectLabel: string;
  /** UI area the contract binds to, rendered in backticks, e.g. "packages/web-v2/". */
  bindingScope: string;
  /** Project-specific "known gaps" bullet texts (no leading "- "). Empty ⇒ section omitted. */
  knownGaps: string[];
}

/** Neutral fallback for a project with no stored uxContractProfile yet. */
export const DEFAULT_UX_SCAFFOLD: UxContractScaffold = {
  projectLabel: 'this project',
  bindingScope: 'the UI codebase',
  knownGaps: [],
};

const GROUP_ORDER = ['designSystem', 'states', 'flows', 'a11y', 'microcopy', 'responsive'] as const;

type UxRuleGroup = (typeof GROUP_ORDER)[number];

const SECTION_HEADERS: Record<UxRuleGroup, string> = {
  designSystem: '## 1. Design system (reuse, never reinvent)',
  states: "## 2. Required states (the part 'make-it-pretty' skips)",
  flows: '## 3. Flows & feedback (task, not screen)',
  a11y: '## 4. Accessibility bar',
  microcopy: '## 5. Microcopy & tone',
  responsive: '## 6. Responsive',
};

// Compiler-owned scaffolding: structural framing not derived from individual rules.
const STATES_SUFFIX =
  "Also: long text truncates gracefully; many-items doesn't break layout; disabled controls show why.";

// prettier-ignore
const DOD =
  '## Definition of UX-Done (review checklist)\n' +
  '[ ] loading  [ ] empty (first-run)  [ ] empty-search (if searchable)  [ ] error + retry  [ ] success/error toast on every mutation  [ ] destructive confirm  [ ] keyboard + visible focus  [ ] works at 375px  [ ] DS primitives + tokens only (no raw hex / 3rd-party lib)  [ ] microcopy tone\n' +
  'Missing any applicable box ⇒ not done.';

// prettier-ignore
function buildPreamble(scaffold: UxContractScaffold): string {
  return (
    `# UX Completeness Contract — ${scaffold.projectLabel}\n\n` +
    `BINDING for any issue that adds/changes UI in \`${scaffold.bindingScope}\`. "UX done" = every item below is satisfied, not just the happy/full screen. A pretty screen missing a required state is NOT done — review must REQUEST CHANGES.`
  );
}

function buildKnownGaps(scaffold: UxContractScaffold): string | null {
  if (scaffold.knownGaps.length === 0) return null;
  const bullets = scaffold.knownGaps.map((g) => `- ${g}`).join('\n');
  return `## Known gaps (don't 'fix' by reinventing — work within these)\n${bullets}`;
}

export function compileUxContract(
  rules: UxContractRuleInput[],
  scaffold: UxContractScaffold = DEFAULT_UX_SCAFFOLD,
): string {
  const active = rules.filter((r) => r.status === 'active');

  const byGroup = new Map<UxRuleGroup, UxContractRuleInput[]>();
  for (const group of GROUP_ORDER) {
    byGroup.set(group, []);
  }
  for (const rule of active) {
    if ((GROUP_ORDER as readonly string[]).includes(rule.group)) {
      byGroup.get(rule.group as UxRuleGroup)?.push(rule);
    }
  }
  for (const groupRules of byGroup.values()) {
    groupRules.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  const sections: string[] = [];
  for (const group of GROUP_ORDER) {
    const groupRules = byGroup.get(group) ?? [];
    const header = SECTION_HEADERS[group];
    const bullets = groupRules.map((r) => `- ${r.text}`).join('\n');
    let sectionBody = `${header}\n${bullets}`;
    if (group === 'states') {
      sectionBody += `\n${STATES_SUFFIX}`;
    }
    sections.push(sectionBody);
  }

  const parts: string[] = [buildPreamble(scaffold), ...sections];
  const knownGaps = buildKnownGaps(scaffold);
  if (knownGaps) parts.push(knownGaps);
  parts.push(DOD);

  return parts.join('\n\n');
}
