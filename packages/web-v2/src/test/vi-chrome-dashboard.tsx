import { NavRail } from "@/design/patterns/nav-rail";
import { PROJECT_ITEMS, WORKSPACE_ITEMS } from "@/features/shell";
import type { ChromeScreen } from "./vi-chrome-screens";

// The navigation rail for the vi walking test (the old Dashboard figures went with ISS-1067).

export const SCREENS: ChromeScreen[] = [
  {
    name: "Navigation rail",
    render: () => <NavRail workspaceItems={WORKSPACE_ITEMS} projectItems={PROJECT_ITEMS} activeKey="proj-overview" />,
  },
];
