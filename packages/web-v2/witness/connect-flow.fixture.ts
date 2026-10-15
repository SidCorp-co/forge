// The core a connect-flow witness talks to: a Coolify connection, this Forge's own GitHub App with an
// installation no project uses yet, an org, three projects, the App's repositories with what core
// matched for each project, and an empty answer for every read a provider's form makes while it opens.
// Connect GitHub answers as forge-dev does while its App awaits completion: complete it, never a manifest.

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
  {
    ...CONNECTION,
    id: "gh1",
    ownerType: "instance",
    ownerId: "00000000-0000-0000-0000-000000000000",
    provider: "github",
    displayName: "GitHub App forge-dev-env",
    config: { appSlug: "forge-dev-env", appOwner: "SidCorp-co", appOwnerIsOrg: true },
    usage: { bindings: [] },
  },
];

const PROJECTS = [
  { id: "p1", slug: "forge", name: "Forge", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
  { id: "p2", slug: "autoflow", name: "Autoflow", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
  { id: "p3", slug: "musetools", name: "Musetools", orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, orgRole: "owner", archivedAt: null },
];

const repo = (owner: string, name: string, installationId = 171606736) => ({ provider: "github", installationId, owner, repo: name });

const TARGETS = {
  targets: [repo("SidCorp-co", "forge"), repo("SidCorp-co", "autoflow"), repo("SidCorp-co", "musetools"), repo("chuongld", "musetools", 4242)],
  truncated: false,
  suggestedFor: [
    { projectId: "p1", by: "repository", target: repo("SidCorp-co", "forge") },
    { projectId: "p2", by: "slug", target: repo("SidCorp-co", "autoflow") },
    { projectId: "p3", by: "ambiguous", candidates: [repo("SidCorp-co", "musetools"), repo("chuongld", "musetools", 4242)] },
  ],
};

const APP_ROW = {
  connectionId: "gh1",
  instance: true,
  slug: "forge-dev-env",
  owner: "SidCorp-co",
  visibility: "private",
  makePublicUrl: "https://github.com/organizations/SidCorp-co/settings/apps/forge-dev-env/advanced",
  completePath: null,
  installations: [
    {
      installationId: 171606736,
      account: "SidCorp-co",
      accountType: "Organization",
      state: "active",
      used: false,
      settingsUrl: "https://github.com/organizations/SidCorp-co/settings/installations/171606736",
    },
  ],
};

const CONNECT_COMPLETE = {
  kind: "complete",
  connectionId: "fea7dc5e",
  displayName: "GitHub App forge-dev-env",
  completePath: "/api/integration-connections/fea7dc5e/github-app/complete",
};

/** A project with no repository binding: the repository it declared, unreached, and GitHub's row to connect it. */
const CARDS = [
  {
    key: "repository",
    label: "Repository",
    status: "not_configured",
    detail: "Not connected to GitHub yet",
    says: { detail: { key: "integrations.detail.unreachedConnect", vars: { provider: "GitHub" } } },
    lastSyncAt: null,
    configured: true,
    meta: { repository: "github.com/SidCorp-co/autoflow", remoteUrl: "https://github.com/SidCorp-co/autoflow", host: "github.com", provider: null, connectProvider: "github" },
  },
  {
    key: "github",
    label: "GitHub",
    status: "not_configured",
    detail: "no GitHub integration configured",
    says: { detail: { key: "integrations.detail.noneConfigured", vars: { provider: "GitHub" } } },
    lastSyncAt: null,
    configured: false,
    meta: { capabilities: { hasDeliveryLog: false } },
  },
];

const REPOSITORIES = {
  repositories: TARGETS.targets.map((t) => ({ installationId: t.installationId, account: t.owner, owner: t.owner, repo: t.repo, fullName: `${t.owner}/${t.repo}` })),
  truncated: false,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export function stubCore(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/integration-connections/github/connect") return json(CONNECT_COMPLETE);
    if (method !== "GET") return json({});
    if (path === "/integration-connections") return json({ items: ITEMS });
    if (path === "/integration-connections/gh1/targets") return json(TARGETS);
    if (path === "/integration-connections/gh1/github-app") return json(APP_ROW);
    if (path === "/orgs") return json([{ id: "o1", name: "SidCorp", role: "owner", isPersonal: false }]);
    if (path === "/projects") return json(PROJECTS);
    if (/^\/projects\/p\d\/integrations\/status$/.test(path)) return json({ cards: CARDS });
    if (/^\/projects\/p\d\/integrations\/github\/repositories$/.test(path)) return json(REPOSITORIES);
    if (/^\/projects\/p\d\/integrations\/mcp-preview$/.test(path)) return json({ servers: [] });
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

/** The window's own width: a phone's layout viewport widens to whatever overflows it, so `innerWidth` cannot see the overflow. */
export const windowWidth = () => window.visualViewport?.width ?? window.innerWidth;

export function sideways(): string[] {
  return document.documentElement.scrollWidth > windowWidth()
    ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${windowWidth()}`]
    : [];
}

/** A button by its visible text, inside `within`. */
export function buttonNamed(within: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
}

/**
 * Where a laid-out text wraps: one entry per line after the first, naming the character a line starts
 * with and the one before it, read off the boxes Chrome drew for each character.
 */
export function lineStarts(el: Element): { before: string; at: string }[] {
  const chars: { node: Text; i: number }[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n as Text;
    for (let i = 0; i < text.data.length; i += 1) chars.push({ node: text, i });
  }
  const starts: { before: string; at: string }[] = [];
  let lastTop: number | null = null;
  chars.forEach(({ node, i }, k) => {
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const top = range.getBoundingClientRect().top;
    if (lastTop !== null && top > lastTop + 2) {
      const prev = chars[k - 1];
      starts.push({ before: prev ? prev.node.data[prev.i] ?? "" : "", at: node.data[i] ?? "" });
    }
    lastTop = top;
  });
  return starts;
}
