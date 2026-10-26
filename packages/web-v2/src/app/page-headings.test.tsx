// @vitest-environment jsdom
//
// ISS-1229 r47, judge-443/444: the room's own failed read headed Conversations with "Conversation",
// the five /admin/* placeholders had no h1, /usage and /attention with nothing waiting showed their
// empty state as a subheading, and Agents with no runs had no h1. Every page has exactly one h1, and
// the tab says what it says, whatever the page's reads answered: each route in the app is rendered in
// its layouts with every read failing, answering with nothing, and answering with something.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiState,
  type Answer,
  type Read,
  answering,
  projectOnly,
  readsFor,
  ISSUE_ID,
  PROJECT,
  ROOM_ID,
  RUN_ID,
  SESSION_ID,
  SLUG,
  stubApi,
} from "@/test-support/route-api";

const here = vi.hoisted(() => ({ pathname: "/", params: {} as Record<string, string> }));

class NotFound extends Error {}
class Redirected extends Error {}

vi.mock("next/navigation", () => {
  // The router moves the address as Next's does, so a page that drops its query string is seen to.
  const go = (method: "pushState" | "replaceState") => (href: string) => {
    const url = new URL(href, window.location.href);
    here.pathname = url.pathname;
    window.history[method](null, "", `${url.pathname}${url.search}`);
  };
  const router = { push: go("pushState"), replace: go("replaceState"), back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
  return {
    usePathname: () => here.pathname,
    useRouter: () => router,
    useParams: () => here.params,
    useSearchParams: () => new URLSearchParams(window.location.search),
    notFound: () => {
      throw new NotFound(here.pathname);
    },
    redirect: (to: string) => {
      throw new Redirected(to);
    },
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) =>
    createElement("a", { href: typeof href === "string" ? href : String(href), ...rest }, children),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, toString: () => "" }), headers: async () => new Headers() }));

const { createQueryClient } = await import("@/providers/query-provider");
const { AuthProvider } = await import("@/providers/auth-provider");
const { ToastProvider } = await import("@/providers/toast-provider");
const { ThemeProvider } = await import("@/providers/theme-provider");
const { OperatorShell } = await import("@/features/operator");

type Module = { default: (props: never) => ReactNode | Promise<ReactNode>; generateMetadata?: (props: never) => Promise<{ title?: unknown }>; metadata?: { title?: unknown } };

const PAGES = import.meta.glob<Module>("./**/page.tsx");
const LAYOUTS = import.meta.glob<{ default: (props: { children: ReactNode }) => ReactNode }>("./**/layout.tsx");

/** Routes this test cannot render, each with why. A page.tsx neither rendered nor named here fails. */
const NOT_RENDERED: Record<string, string> = {
  "./kit/page.tsx": "the design kit is not served: kit/layout.tsx answers 404 in production",
  "./kit/sandbox/page.tsx": "the design kit is not served: kit/layout.tsx answers 404 in production",
};

const PARAMS: Record<string, string> = { slug: SLUG, id: ISSUE_ID, sessionId: SESSION_ID, runId: RUN_ID };

interface Route {
  file: string;
  /** The address opened, with any dynamic segment filled in. */
  path: string;
  params: Record<string, string>;
  layouts: string[];
}

function routeOf(file: string): Route {
  const dirs = file.replace(/^\.\//, "").replace(/\/?page\.tsx$/, "").split("/").filter(Boolean);
  const params: Record<string, string> = {};
  const segments: string[] = [];
  const layouts: string[] = [];
  for (let i = 0; i <= dirs.length; i++) {
    const layout = `./${[...dirs.slice(0, i), "layout.tsx"].join("/")}`;
    if (i > 0 && layout in LAYOUTS) layouts.push(layout);
    const dir = dirs[i];
    if (dir === undefined || /^\(.*\)$/.test(dir)) continue;
    const dynamic = /^\[(.+)\]$/.exec(dir);
    if (dynamic) {
      const name = dynamic[1] as string;
      const value = file.startsWith("./guides/") ? "issue-dependencies" : PARAMS[name];
      if (!value) throw new Error(`${file}: no value for the [${name}] segment — add it to PARAMS`);
      params[name] = value;
      segments.push(value);
    } else segments.push(dir);
  }
  return { file, path: `/${segments.join("/")}`, params, layouts };
}

const ROUTES = Object.keys(PAGES).sort().map(routeOf);

/** A module the glob found, refused by name where it found none. */
function loaded<T>(modules: Record<string, () => Promise<T>>, file: string): () => Promise<T> {
  const load = modules[file];
  if (!load) throw new Error(`${file} is not a module under src/app`);
  return load;
}

/** Next's own metadata, as it would write the tab before the page's client code runs. */
async function metadataTitle(mod: Module, props: object): Promise<string | null> {
  const meta = mod.generateMetadata ? await mod.generateMetadata(props as never) : mod.metadata;
  const title = meta?.title;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && "absolute" in title) return String((title as { absolute: unknown }).absolute);
  return null;
}

async function open(route: Route, search = ""): Promise<{ client: ReturnType<typeof createQueryClient> }> {
  here.pathname = route.path;
  here.params = route.params;
  window.history.replaceState(null, "", `${route.path}${search}`);
  document.title = "Forge";
  const mod = await loaded(PAGES, route.file)();
  const props = { params: Promise.resolve(route.params), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(search))) };
  const metaTitle = await metadataTitle(mod, props);
  if (metaTitle) document.title = metaTitle;
  // A server page is an async function Next awaits; a client page is a component React calls.
  const server = mod.default.constructor.name === "AsyncFunction";
  let page: ReactNode = server ? await mod.default(props as never) : createElement(mod.default as never, props as never);
  for (const layout of [...route.layouts].reverse()) {
    if (layout === "./admin/layout.tsx") {
      page = <OperatorShell initialWhoami={{ isAdmin: true, email: "reader@example.org" }}>{page}</OperatorShell>;
      continue;
    }
    const { default: Layout } = await loaded(LAYOUTS, layout)();
    page = createElement(Layout, null, page);
  }
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false, retryDelay: 0 } });
  await act(async () => {
    render(
      createElement(
        ThemeProvider,
        null,
        createElement(QueryClientProvider, { client }, createElement(AuthProvider, null, createElement(ToastProvider, null, page))),
      ),
    );
  });
  await settle(client);
  return { client };
}

/** Waits until no read is out and nothing is still being drawn from one. */
async function settle(client: ReturnType<typeof createQueryClient>) {
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    if (client.isFetching() === 0 && client.isMutating() === 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      if (client.isFetching() === 0) return;
    }
  }
  throw new Error(`reads still out after settling: ${client.getQueryCache().findAll({ fetchStatus: "fetching" }).map((q) => JSON.stringify(q.queryKey)).join(", ")}`);
}

/** The page's one h1 and the tab that names it. */
function headsOnce(label: string) {
  const h1s = [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim());
  expect(h1s, `${label}: exactly one h1, read ${JSON.stringify(h1s)}`).toHaveLength(1);
  // The workspace's tabs read `<h1> · Forge`; the public docs' read `<h1> — Forge documentation`, their landing the name alone.
  const h1 = h1s[0];
  expect([`${h1} · Forge`, `${h1} — Forge documentation`, h1], `${label}: the tab says the h1's words, read "${document.title}"`).toContain(document.title);
}

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = () => {};
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(cleanup);

describe("the route table", () => {
  it("renders or names every page in the app", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    for (const file of Object.keys(NOT_RENDERED)) expect(Object.keys(PAGES), `${file} is named but is no page`).toContain(file);
  });
});

interface Variant {
  name: string;
  state: ApiState;
  reads: () => Read[];
}

const VARIANTS: Variant[] = [
  { name: "every read failing", state: "failed", reads: () => [] },
  { name: "the project list answering and every other read failing", state: "failed", reads: projectOnly },
  { name: "an organization holding no project", state: "empty", reads: () => readsFor("empty", { noProjects: true }) },
  { name: "every read answering with nothing", state: "empty", reads: () => readsFor("empty") },
  { name: "every read answering with something", state: "loaded", reads: () => readsFor("loaded") },
];

describe.each(VARIANTS)("every page, with $name,", ({ state, reads }) => {
  const rendered = ROUTES.filter((r) => !(r.file in NOT_RENDERED));
  it.each(rendered.map((r) => [r.path, r] as const))("%s has one h1 the tab names", async (_path, route) => {
    const api = stubApi(state, reads());
    try {
      const { client } = await open(route);
      expect([...api.unanswered], `${route.path} made reads the ${state} table does not answer`).toEqual([]);
      if (state !== "failed") {
        const refused = client.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" }).map((q) => `${JSON.stringify(q.queryKey)}: ${String(q.state.error)}`);
        expect(refused, `${route.path}: the ${state} answers were refused by the page that read them: ${refused.join(" ; ")}`).toEqual([]);
      }
      headsOnce(`${route.path} (${state})`);
    } finally {
      api.restore();
    }
  });
});

interface Address {
  /** The page file, as the route table names it. */
  file: string;
  search: string;
  name: string;
  state: ApiState;
  reads: () => Read[];
}

const FAILING: Answer = { status: 500, code: "INTERNAL", message: "The server ran into a problem and could not finish the request." };
const ROOM_PATH = /^\/conversations\/[0-9a-f-]{36}$/;

/** The addresses a page is opened at beside its bare one, each in the states its query string reaches. */
const ADDRESSES: Address[] = [
  { file: "./(workspace)/conversations/page.tsx", search: `?room=${ROOM_ID}`, name: "a room that opens", state: "loaded", reads: () => readsFor("loaded") },
  {
    file: "./(workspace)/conversations/page.tsx",
    search: `?room=${ROOM_ID}`,
    name: "a room whose own read fails",
    state: "failed",
    reads: () => [answering(ROOM_PATH, FAILING), ...readsFor("loaded")],
  },
  {
    file: "./(workspace)/conversations/page.tsx",
    search: `?room=${ROOM_ID}`,
    name: "a room that is gone",
    state: "failed",
    reads: () => [answering(ROOM_PATH, { status: 404, code: "NOT_FOUND", message: "No such conversation." }), ...readsFor("loaded")],
  },
  {
    file: "./(workspace)/conversations/page.tsx",
    search: `?room=${ROOM_ID}`,
    name: "a room about a project the reader's role was taken from",
    state: "failed",
    reads: () => [
      answering(ROOM_PATH, { status: 403, code: "CONVERSATION_OUT_OF_SCOPE", message: "This conversation is about a project you are not a member of." }),
      ...readsFor("loaded"),
    ],
  },
  {
    file: "./(workspace)/conversations/page.tsx",
    search: "",
    name: "the project list alone failing",
    state: "failed",
    reads: () => [answering(/^\/projects$/, FAILING), ...readsFor("loaded")],
  },
  { file: "./guides/page.tsx", search: "?path=configure-the-pipeline", name: "a help page", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./guides/page.tsx", search: "?for=agent", name: "the agents' door", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./guides/page.tsx", search: "?for=user", name: "the people's door", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./guides/page.tsx", search: "?for=nobody", name: "a door that is not one", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./guides/page.tsx", search: "?path=configure-the-pipeline", name: "a help page while the index is down", state: "failed", reads: () => [] },
  { file: "./invite/accept/page.tsx", search: "?token=t1", name: "a project invitation", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./invite/accept/page.tsx", search: "?token=t1&kind=org", name: "an organization invitation", state: "loaded", reads: () => readsFor("loaded") },
  { file: "./invite/accept/page.tsx", search: "?token=t1", name: "an invitation whose read fails", state: "failed", reads: () => [] },
  {
    file: "./link-chat/page.tsx",
    search: `?projectId=${PROJECT.id}&source=slack&externalId=U1`,
    name: "a chat account to link",
    state: "loaded",
    reads: () => readsFor("loaded"),
  },
  { file: "./link-chat/page.tsx", search: `?projectId=${PROJECT.id}&source=slack&externalId=U1`, name: "a link whose read fails", state: "failed", reads: () => [] },
  { file: "./integrations/github/landed/page.tsx", search: "?code=STATE_MISMATCH", name: "GitHub's refusal", state: "loaded", reads: () => readsFor("loaded") },
];

describe("every page at the addresses its query string reaches", () => {
  it.each(ADDRESSES.map((a) => [`${routeOf(a.file).path}${a.search} (${a.name})`, a] as const))("%s has one h1 the tab names", async (label, address) => {
    const api = stubApi(address.state, address.reads());
    try {
      const { client } = await open(routeOf(address.file), address.search);
      expect([...api.unanswered], `${label} made reads the ${address.state} table does not answer`).toEqual([]);
      if (address.state !== "failed") {
        const refused = client.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" }).map((q) => `${JSON.stringify(q.queryKey)}: ${String(q.state.error)}`);
        expect(refused, `${label}: refused ${refused.join(" ; ")}`).toEqual([]);
      }
      headsOnce(label);
      expect(window.location.search, `${label}: the address is kept`).toBe(address.search);
    } finally {
      api.restore();
    }
  });
});

