// What a project must tell the autonomous driver skill about itself.
//
// The staged pipeline solved per-project specificity by FORKING skills: every
// project that built differently got its own copy of forge-code, and the copies
// drifted from the original the day they were made. Autonomous mode runs ONE
// driver skill for every project — `issue-flow`, from Forge's own plugin repo
// github.com/SidCorp-co/forge-plugin — so the difference has to live in data.
//
// `projectFacts` is already that place — a kebab-key → free-text map the author
// owns (see ./project-facts.ts). This file adds the only thing it was missing:
// a DECLARED list of which keys the driver consults, so "this project is ready
// to run autonomous" is a question with an answer.
//
// Design: docs/proposals/agent-driven-pipeline.md

export interface AutonomousFact {
  /** `projectFacts` key, and the `{{project:<key>}}` name in a skill body. */
  key: string;
  /** What the agent uses it for. Rendered to the operator when it is missing. */
  role: string;
  required: boolean;
}

// cm:guard required means "a phase cannot finish without it", never "nice to have" — every required key blocks the switch to autonomous mode, so adding one here locks out every project that has been running fine without it
export const AUTONOMOUS_FACT_CONTRACT: readonly AutonomousFact[] = [
  {
    key: 'build-commands',
    role: 'how to build this project, so phase 3 can prove the branch compiles',
    required: true,
  },
  {
    key: 'test-commands',
    role: 'how to run the tests the reviewer’s verdict rests on — a verdict with no test run is an opinion',
    required: true,
  },
  {
    key: 'merge-target',
    role: 'where a finished branch lands when it is NOT the base it was checked out from',
    required: false,
  },
  {
    key: 'deploy-policy',
    role: 'whether shipping deploys, and what gates it',
    required: false,
  },
  {
    key: 'reproduction',
    role: 'how a bug is reproduced here — the local URL, the seed data, the account to use',
    required: false,
  },
  {
    key: 'done-means',
    role: 'what this project counts as finished beyond the acceptance criteria',
    required: false,
  },
];

function factText(projectFacts: unknown, key: string): string {
  if (typeof projectFacts !== 'object' || projectFacts === null) return '';
  const value = (projectFacts as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Required contract keys this project has not answered. Empty means the project
 * can run autonomous. A key present but blank counts as missing — an empty
 * string is how a half-finished settings form leaves a field.
 */
export function missingAutonomousFacts(projectFacts: unknown): AutonomousFact[] {
  return AUTONOMOUS_FACT_CONTRACT.filter(
    (f) => f.required && factText(projectFacts, f.key).trim().length === 0,
  );
}

/** The contract keys this project HAS answered, in contract order, for rendering. */
export function declaredAutonomousFacts(projectFacts: unknown): Array<{
  fact: AutonomousFact;
  text: string;
}> {
  const out: Array<{ fact: AutonomousFact; text: string }> = [];
  for (const fact of AUTONOMOUS_FACT_CONTRACT) {
    const text = factText(projectFacts, fact.key).trim();
    if (text.length > 0) out.push({ fact, text });
  }
  return out;
}
