import { say } from "./said";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { LandsThisWeek } from "@/features/project-dashboard/components/plan-sections";
import type { PlanRow } from "@/features/project-dashboard/ba-derive";
import { NavRail } from "@/design/patterns/nav-rail";
import { PROJECT_ITEMS, WORKSPACE_ITEMS } from "@/features/shell";
import type { ChromeScreen } from "./vi-chrome-screens";

// The project dashboard and the navigation rail, for the vi walking test.

const clock = { lang: "vi" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };
const row = (key: string, over: Partial<PlanRow> = {}): PlanRow => ({ kind: "requirement", key, title: `Muc ${key}`, release: null, href: `/projects/hop/requirements/${key}`, eta: null, late: null, ...over });

export const SCREENS: ChromeScreen[] = [
  {
    name: "Dashboard",
    render: () => (
      <>
        <BaFigures
          slug="hop"
          requirements={[{ state: "in_delivery", count: 2 }, { state: "delivered", count: 1 }] as never}
          feedback={{ open: 3, untriaged: 1, aging: 1 }}
          release={null}
          clock={clock}
        />
        <LandsThisWeek slug="hop" clock={clock} rows={[row("REQ-2"), row("REQ-3", { release: { version: "0.1.0", who: say("standing.who.holderOf", { perm: "releases.approve" }) } }), row("REQ-4", { release: { version: "0.1.0", who: say("standing.who.holderOf", { perm: "releases.approve" }) } })]} />
      </>
    ),
  },
  {
    name: "Navigation rail",
    render: () => <NavRail workspaceItems={WORKSPACE_ITEMS} projectItems={PROJECT_ITEMS as never} activeKey="proj-overview" />,
  },
];
