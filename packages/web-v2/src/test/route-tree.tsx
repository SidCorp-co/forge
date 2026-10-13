// Mounts a route file's page under a real router, for a test of what the routes compose: the
// workspace layout around a page, the reads a page sends, where a link or a verb takes the browser.
// A test of one screen renders it with the navigation double instead (src/test/navigation.tsx).
import type { QueryClient } from "@tanstack/react-query";
import {
  type RouteComponent,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderWithQuery } from "./render";

/** The component a route file mounts; `file` names it when it mounts none. */
export function componentOf(route: { options: { component?: unknown } }, file: string): RouteComponent {
  const component = route.options.component;
  if (typeof component !== "function") throw new Error(`${file} declares a route with no component to mount`);
  return component as RouteComponent;
}

interface Mount {
  /** The address the browser is opened at: path, search and hash. */
  at: string;
  /** The route the page answers, naming its params: `/projects/$slug/issues/$id`. */
  pattern: string;
  page: RouteComponent;
  /** A layout around the page, drawing it at its `<Outlet />`. */
  layout?: RouteComponent;
  /** The path the app is served under, as WEB_V2_BASE_PATH sets it; `at` carries it too. */
  basepath?: string;
}

function treeOf({ pattern, page, layout }: Pick<Mount, "pattern" | "page" | "layout">) {
  const root = createRootRoute();
  if (!layout) return root.addChildren([createRoute({ getParentRoute: () => root, path: pattern, component: page })]);
  const shell = createRoute({ getParentRoute: () => root, id: "layout", component: layout });
  return root.addChildren([shell.addChildren([createRoute({ getParentRoute: () => shell, path: pattern, component: page })])]);
}

/**
 * Opens a memory router at `at` with the one route `pattern`, and draws it once the router has
 * matched, so the page is on screen when this resolves. Where the page sends the browser is read
 * back from `router.state.location`.
 */
export async function renderRoute(mount: Mount, client?: QueryClient) {
  const router = createRouter({
    routeTree: treeOf(mount),
    basepath: mount.basepath,
    history: createMemoryHistory({ initialEntries: [mount.at] }),
  });
  await router.load();
  return { router, ...renderWithQuery(<RouterProvider router={router} />, client) };
}
