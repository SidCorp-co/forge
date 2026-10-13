// A witness entry's component, mounted under a router the way a page of the web is: a screen reads its
// location, params and navigation from it (src/lib/navigation/router.tsx). `at` is the address the
// page is opened at; `pattern` is the route it matches, which names the params (`/projects/$slug`).
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type ReactNode, createContext, useContext, useState } from "react";

const Slot = createContext<ReactNode>(null);

function Page() {
  return <>{useContext(Slot)}</>;
}

export function InRouter({ at = "/", pattern = at.split("?")[0], children }: { at?: string; pattern?: string; children: ReactNode }) {
  const [router] = useState(() => {
    const root = createRootRoute();
    const page = createRoute({ getParentRoute: () => root, path: pattern, component: Page });
    return createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: [at] }) });
  });
  return (
    <Slot.Provider value={children}>
      <RouterProvider router={router} />
    </Slot.Provider>
  );
}
