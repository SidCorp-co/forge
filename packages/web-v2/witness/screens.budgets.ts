// Each screen's word budget on its first view at 1440x900 (REQ-11 BC-21): the most words a person
// may meet before they scroll, hover or open anything, counted by witness/first-screen.ts over the
// screen witness/screens-all.witness.tsx draws. The budget is the ISS-903 audit's Target column
// (~/forge-local-docs/iss903-audit/index.md), and none is above 110.
//
// A screen not yet rewritten onto the disclosure kit carries an amnesty: a ceiling at the count it
// drew when the audit measured it, so it may not grow while it waits, and the condition that ends
// it. An amnesty whose screen has come within its budget is refused too: it is spent, and stays
// written only as a lie about the screen.

export const MOST_WORDS = 110;

interface Amnesty {
  /** The count the screen drew when the audit measured it: it may not draw more. */
  ceiling: number;
  /** What ends it. */
  ends: string;
}

export interface ScreenBudget {
  budget: number;
  amnesty?: Amnesty;
}

const SLICE_B = "ISS-903 rewrites the screen onto the disclosure kit";
const waits = (ceiling: number): Amnesty => ({ ceiling, ends: SLICE_B });

export const BUDGETS: Record<string, ScreenBudget> = {
  "project-home": { budget: 100 },
  "issues-list": { budget: 90 },
  "issue-detail": { budget: 80 },
  "requirements-list": { budget: 80, amnesty: waits(93) },
  "requirement-detail": { budget: 100 },
  "feedback-list": { budget: 100 },
  "feedback-detail": { budget: 90 },
  "releases-list": { budget: 90 },
  "release-detail": { budget: 80 },
  "workflows-list": { budget: 60, amnesty: waits(71) },
  "workflow-design": { budget: 90 },
  "agents-runs": { budget: 110 },
  "agents-master": { budget: 90 },
  "run-detail": { budget: 70 },
  "session-detail": { budget: 50 },
  automation: { budget: 60 },
  "schedule-detail": { budget: 80 },
  "fire-detail": { budget: 70 },
  "contract-detail": { budget: 70 },
  "development-overview": { budget: 100 },
  "project-settings": { budget: 70 },
  integrations: { budget: 80, amnesty: waits(101) },
  runners: { budget: 80 },
  // ISS-919: three flat tables of three rows each (waiting on you, moving, live) at the cap any first
  // view may hold; the Overview it replaced drew 120 in the same frame, now under its Figures tab
  "owner-home": { budget: 110 },
  "org-home": { budget: 50 },
  "settings-account": { budget: 50 },
  approvals: { budget: 110 },
  status: { budget: 100 },
  "forge-feedback": { budget: 50, amnesty: waits(64) },
  "ecosystems-home": { budget: 20 },
  "ecosystem-detail": { budget: 100 },
  docs: { budget: 100 },
  "sign-in": { budget: 11 },
  register: { budget: 15 },
  "not-found": { budget: 8, amnesty: waits(12) },
  ops: { budget: 40 },
};

/** One drawn count per screen: `WORDS <screen> <theme> <n>` as the witness prints it. */
export function countsOf(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of output.matchAll(/WORDS (\S+) light (\d+)/g)) counts.set(m[1], Number(m[2]));
  return counts;
}

/** Every way the drawn counts break the budgets, one sentence each naming the screen. */
export function overBudget(counts: ReadonlyMap<string, number>, budgets: Readonly<Record<string, ScreenBudget>> = BUDGETS): string[] {
  const wrong: string[] = [];
  for (const [screen, b] of Object.entries(budgets)) {
    if (b.budget > MOST_WORDS) wrong.push(`${screen}: a budget of ${b.budget} words is over the ${MOST_WORDS} any first view may hold`);
    const n = counts.get(screen);
    if (n === undefined) {
      wrong.push(`${screen}: has a budget but the witness drew no such screen`);
      continue;
    }
    if (b.amnesty) {
      if (n <= b.budget) wrong.push(`${screen}: ${n} words is within its budget of ${b.budget}, so its amnesty (${b.amnesty.ends}) is spent: remove it`);
      else if (n > b.amnesty.ceiling) wrong.push(`${screen}: ${n} words on its first view, over its amnesty's ceiling of ${b.amnesty.ceiling} (budget ${b.budget}; ${b.amnesty.ends})`);
    } else if (n > b.budget) {
      wrong.push(`${screen}: ${n} words on its first view, over its budget of ${b.budget}`);
    }
  }
  for (const screen of counts.keys()) if (!(screen in budgets)) wrong.push(`${screen}: drawn with no word budget: give it the audit's target`);
  return wrong;
}
