// The core a connect-flow witness talks to: two connections, an org, three projects, a GitHub App's
// repositories, and an empty answer for every read a provider's form makes while it opens.

const CONNECTION = {
  ownerType: "org",
  ownerId: "o1",
  active: true,
  lastHealthStatus: "ok",
  lastHealthDetail: null,
  lastHealthAt: null,
  breakerOpenedAt: null,
  directoryStatus: "connected",
  hasSecrets: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const ITEMS = [
  { ...CONNECTION, id: "c1", provider: "coolify", displayName: "Coolify (manage.example.com)", config: { baseUrl: "https://manage.example.com" }, usage: { bindings: [{ id: "b1", projectId: "p1", role: "deploy", label: "", name: "dev", active: true }] } },
  { ...CONNECTION, id: "c3", provider: "github", displayName: "GitHub App forge-sidcorp", config: {}, usage: { bindings: [] } },
];

const PROJECTS = [
  { id: "p1", slug: "forge", name: "Forge", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
  { id: "p2", slug: "autoflow", name: "Autoflow", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
  { id: "p3", slug: "musetools", name: "Musetools", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
];

const TARGETS = {
  targets: ["forge", "autoflow", "musetools"].map((repo) => ({ provider: "github", installationId: 77, owner: "SidCorp-co", repo })),
  truncated: false,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export function stubCore(): void {
  window.fetch = async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
    if (path === "/integration-connections") return json({ items: ITEMS });
    if (path === "/integration-connections/c3/targets") return json(TARGETS);
    if (path === "/orgs") return json([{ id: "o1", name: "SidCorp", role: "owner", isPersonal: false }]);
    if (path === "/projects") return json(PROJECTS);
    if (/^\/projects\/p\d\/integrations$/.test(path)) return json({ items: [] });
    return json({});
  };
}

/** Set a native select the way a person's pick does, so React's onChange hears it. */
export function pick(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));

export function sideways(): string[] {
  return document.documentElement.scrollWidth > window.innerWidth
    ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`]
    : [];
}
