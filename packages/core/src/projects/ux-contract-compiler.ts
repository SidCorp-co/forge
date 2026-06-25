export interface UxContractRuleInput {
  group: string;
  text: string;
  status: string;
  orderIndex: number;
}

const GROUP_ORDER = [
  'designSystem',
  'states',
  'flows',
  'a11y',
  'microcopy',
  'responsive',
] as const;

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
const PREAMBLE =
  `# UX Completeness Contract — web-v2 (forge-dev)\n\n` +
  `BINDING for any issue that adds/changes UI in \`packages/web-v2/\`. "UX done" = every item below is satisfied, not just the happy/full screen. A pretty screen missing a required state is NOT done — review must REQUEST CHANGES.`;

// prettier-ignore
const KNOWN_GAPS =
  `## Known gaps (don't 'fix' by reinventing — work within these)\n` +
  `- No i18n → hardcode English, don't wire a translation lib.\n` +
  `- Dark theme is RESERVED in tokens but not shipped → don't add dark-only styles.\n` +
  `- No jsx-a11y linter (lint WIP) → verify a11y by hand against §4.\n` +
  `- \`SlideOver\`/modals lack a focus trap & there's no skip-link → for a NEW modal, add focus trap + Esc-to-close yourself.`;

// prettier-ignore
const DOD =
  `## Definition of UX-Done (review checklist)\n` +
  `[ ] loading  [ ] empty (first-run)  [ ] empty-search (if searchable)  [ ] error + retry  [ ] success/error toast on every mutation  [ ] destructive confirm  [ ] keyboard + visible focus  [ ] works at 375px  [ ] DS primitives + tokens only (no raw hex / 3rd-party lib)  [ ] microcopy tone\n` +
  `Missing any applicable box ⇒ not done.`;

export function compileUxContract(rules: UxContractRuleInput[]): string {
  const active = rules.filter((r) => r.status === 'active');

  const byGroup = new Map<UxRuleGroup, UxContractRuleInput[]>();
  for (const group of GROUP_ORDER) {
    byGroup.set(group, []);
  }
  for (const rule of active) {
    if ((GROUP_ORDER as readonly string[]).includes(rule.group)) {
      byGroup.get(rule.group as UxRuleGroup)!.push(rule);
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

  return `${PREAMBLE}\n\n${sections.join('\n\n')}\n\n${KNOWN_GAPS}\n\n${DOD}`;
}
