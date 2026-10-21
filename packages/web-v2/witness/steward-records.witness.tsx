// The steward's record surfaces, witnessed as drawn (REQ-48 lane A): the requirements list and a
// requirement page (the stuck banner in core's sentence and the steward's note), the feedback list and
// a feedback page (the FB-74 shape: triaged and stuck), and the issues table (last write beside the
// stuck reason). At 390 px nothing scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-records.witness.tsx --out <dir>

import { FeedbackItemScreen, FeedbackScreen } from "@/features/feedback";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { SCREENS as ISSUE_SCREENS } from "@/test/vi-chrome-issues";
import { Seeded } from "@/test/vi-chrome-requirements";
import { FB_STUCK, FP, fbSeeds, has, ISSUE_STUCK, mountSurfaces, REQ_PROJECT, REQ_STUCK, reqSeeds, type Surface } from "./steward.fixture";

const issueScreen = (name: string) => {
  const s = ISSUE_SCREENS.find((x) => x.name === name);
  if (!s) throw new Error(`no issue fixture screen is named "${name}"`);
  return s.render;
};

const SURFACES: Surface[] = [
  {
    name: "requirements-list",
    path: "/projects/hop/requirements",
    render: () => (
      <Seeded data={reqSeeds()}>
        <RequirementsScreen projectId={REQ_PROJECT} slug="hop" />
      </Seeded>
    ),
    check: () => has("the list", "ISS-498 was sent back on 14 Oct and no master serves forge-dev."),
  },
  {
    name: "requirement-page",
    path: "/projects/hop/requirements/REQ-1",
    render: () => (
      <Seeded data={reqSeeds()}>
        <RequirementScreen projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" />
      </Seeded>
    ),
    check: () => [...has("the banner", REQ_STUCK.reason), ...has("the note", "Asked the owner to start a master")],
  },
  {
    name: "feedback-list",
    path: "/projects/hop/feedback",
    render: () => (
      <Seeded data={fbSeeds()}>
        <FeedbackScreen projectId={FP} slug="hop" />
      </Seeded>
    ),
    check: () => has("the list", "Board loses a card on refresh"),
  },
  {
    name: "feedback-page",
    path: "/projects/hop/feedback/FB-2",
    render: () => (
      <Seeded data={fbSeeds()}>
        <FeedbackItemScreen projectId={FP} slug="hop" fbKey="FB-2" />
      </Seeded>
    ),
    check: () => has("the banner", FB_STUCK.reason),
  },
  {
    name: "issues-table",
    path: "/projects/hop/issues",
    render: issueScreen("Issues table"),
    check: () => (document.querySelector(`[data-testid=issue-last-write][data-stuck=true][title="${ISSUE_STUCK.reason}"]`) ? [] : ["no row's last write is marked stuck with core's sentence"]),
  },
];

mountSurfaces(SURFACES);
