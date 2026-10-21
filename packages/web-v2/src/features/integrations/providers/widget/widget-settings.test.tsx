import { WIDGET_SITE_KEY_PATTERN, widgetBindingConfigSchema } from "@forge/contracts/widget";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { embedSnippet, EMPTY_FORM, formOf, mintSiteKey, parseForm, patchOf } from "./config";
import { WidgetSettings } from "./section";

// The widget's settings, written through the existing integrations routes and parsed by the
// contract's `widgetBindingConfigSchema` before any of it leaves: a field the schema refuses is
// named on that field, a cleared optional field is cleared, and a saved widget shows the script tag
// its client pages embed and, signed, the secret its backend signs with.

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/shop/settings" }));

const SITE_KEY = `fw_site_${"q".repeat(32)}`;

afterEach(() => vi.unstubAllGlobals());

describe("the widget form against the contract", () => {
  it("mints a site key of the contract's shape, a new one each time", () => {
    const a = mintSiteKey();
    expect(a).toMatch(WIDGET_SITE_KEY_PATTERN);
    expect(mintSiteKey()).not.toBe(a);
  });

  it("parses a filled form into a config the schema takes, blanks left out", () => {
    const parsed = parseForm(
      { ...EMPTY_FORM, origins: ["https://shop.example.com", " "], mode: "signed", title: " Help ", accent: "#0f766e", limits: { ...EMPTY_FORM.limits, turnsPerConversation: "12" } },
      SITE_KEY,
    );
    expect(parsed.config).toEqual({
      siteKey: SITE_KEY,
      allowedOrigins: ["https://shop.example.com"],
      identity: { mode: "signed" },
      title: "Help",
      accent: "#0f766e",
      limits: { turnsPerConversation: 12 },
    });
    expect(widgetBindingConfigSchema.safeParse(parsed.config).success).toBe(true);
  });

  it("names each field the schema refuses: the origin by its place, a limit out of bounds, an accent", () => {
    const parsed = parseForm(
      { ...EMPTY_FORM, origins: ["https://ok.example", "https://Shop.example/path"], accent: "teal", limits: { ...EMPTY_FORM.limits, messageMaxChars: "50" } },
      SITE_KEY,
    );
    expect(parsed.config).toBeNull();
    expect(Object.keys(parsed.errors ?? {}).sort()).toEqual(["accent", "messageMaxChars", "originAt"]);
    expect(parsed.errors?.originAt).toEqual([1]);
    expect(Object.keys(parseForm(EMPTY_FORM, SITE_KEY).errors ?? {})).toEqual(["origins"]);
  });

  it("clears an optional field the form emptied, since the binding write keeps a key the patch leaves out", () => {
    const parsed = parseForm({ ...EMPTY_FORM, origins: ["https://shop.example.com"] }, SITE_KEY);
    if (!parsed.config) throw new Error("the form did not parse");
    expect(patchOf(parsed.config)).toEqual({ ...parsed.config, title: null, greeting: null, accent: null, limits: null });
  });

  it("reads a saved config back into the form, and embeds the loader beside the web", () => {
    expect(formOf({ siteKey: SITE_KEY, allowedOrigins: ["https://a.example"], identity: { mode: "email" }, limits: { turnsPerVisitorPerDay: 9 } })).toMatchObject({
      origins: ["https://a.example"],
      mode: "email",
      limits: { turnsPerVisitorPerDay: "9", messageMaxChars: "" },
    });
    expect(embedSnippet(SITE_KEY, "https://forge.example/")).toBe(
      `<script src="https://forge.example/widget.js" data-site-key="${SITE_KEY}" async></script>`,
    );
  });
});

const binding = (mode: "anonymous" | "signed") => ({
  id: "b1",
  provider: "widget",
  label: "",
  role: "service",
  connectionId: "c1",
  config: { siteKey: SITE_KEY, allowedOrigins: ["https://shop.example.com"], identity: { mode }, title: "Help" },
  active: true,
  bindingActive: true,
  connectionActive: true,
  revision: 3,
  createdAt: "2026-10-16T00:00:00.000Z",
  lastHealthStatus: null,
});

function world(items: unknown[], extra: (call: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((call) => {
    const hit = extra(call);
    if (hit) return hit;
    if (call.path === "/projects/p1/integrations") return { body: { items } };
    if (call.path === "/orgs") return { body: [] };
    if (call.path === "/auth/me/preferences") return { body: {} };
    if (/^\/projects(\?|$)/.test(call.path)) return { body: [{ id: "p1", slug: "shop", name: "Shop", orgId: null, archivedAt: null }] };
    if (call.path.startsWith("/projects")) return { body: { id: "p1", slug: "shop", orgId: null } };
    if (call.path === "/integration-connections") return { body: { items: [] } };
    return { body: {} };
  });
}

describe("the widget settings", () => {
  it("creates a widget through the integrations route with a minted site key and a schema-valid config", async () => {
    const calls = world([], (call) =>
      call.method === "POST" && call.path === "/integration-connections" ? { body: { connection: { id: "c1" }, bindings: [] } } : undefined,
    );
    renderWithQuery(<WidgetSettings projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a widget" }));
    await userEvent.click(screen.getByRole("button", { name: "Create widget" }));
    expect(await screen.findByText("Add at least one origin.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.type(screen.getByLabelText("Origin 1"), "https://shop.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create widget" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/integration-connections")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/integration-connections")?.body as {
      provider: string;
      bindings: { target: Record<string, unknown> }[];
    };
    expect(sent.provider).toBe("widget");
    const { provider: _p, ...target } = sent.bindings[0]?.target ?? {};
    expect(widgetBindingConfigSchema.safeParse(target).success).toBe(true);
    expect(target).toMatchObject({ allowedOrigins: ["https://shop.example.com"], identity: { mode: "anonymous" } });
  });

  it("shows the minted key's embed code before the save, and sends that key", async () => {
    const calls = world([], (call) =>
      call.method === "POST" && call.path === "/integration-connections" ? { body: { connection: { id: "c1" }, bindings: [] } } : undefined,
    );
    renderWithQuery(<WidgetSettings projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a widget" }));
    const shown = within(screen.getByTestId("widget-embed")).getByText(WIDGET_SITE_KEY_PATTERN);
    await userEvent.type(screen.getByLabelText("Origin 1"), "https://shop.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create widget" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const sent = calls.find((c) => c.method === "POST")?.body as { bindings: { target: { siteKey: string } }[] };
    expect(sent.bindings[0]?.target.siteKey).toBe(shown.textContent);
  });

  it("names a site key another widget holds, and the next create goes with a fresh key", async () => {
    const taken = {
      status: 422,
      body: {
        error: {
          code: "WIDGET_SITE_KEY_TAKEN",
          refusals: [{ code: "WIDGET_SITE_KEY_TAKEN", path: "/bindings/0/target/siteKey", detail: "another widget binding holds this site key" }],
        },
      },
    };
    let posts = 0;
    const calls = world([], (call) => {
      if (call.method !== "POST" || call.path !== "/integration-connections") return undefined;
      posts += 1;
      return posts === 1 ? taken : { body: { connection: { id: "c1" }, bindings: [] } };
    });
    renderWithQuery(<WidgetSettings projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a widget" }));
    await userEvent.type(screen.getByLabelText("Origin 1"), "https://shop.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create widget" }));
    expect(await screen.findByText("WIDGET_SITE_KEY_TAKEN: Another widget holds this site key. A new one is ready.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create widget" }));
    await waitFor(() => expect(posts).toBe(2));
    const keys = calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { bindings: { target: { siteKey: string } }[] }).bindings[0]?.target.siteKey);
    expect(keys[0]).toMatch(WIDGET_SITE_KEY_PATTERN);
    expect(keys[1]).toMatch(WIDGET_SITE_KEY_PATTERN);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("names a save core refuses for changing the site key", async () => {
    const document = {
      $schema: "https://forge.example/schemas/binding-v1.json",
      version: 1,
      id: "b1",
      role: "service",
      connection: "c1",
      target: { provider: "widget", siteKey: SITE_KEY, allowedOrigins: ["https://shop.example.com"], identity: { mode: "anonymous" }, title: "Help" },
    };
    const calls = world([binding("anonymous")], (call) => {
      if (call.method === "GET" && call.path === "/projects/p1/bindings/b1") return { body: { declared: true, revision: 3, document } };
      if (call.method === "PUT" && call.path === "/projects/p1/bindings/b1")
        return {
          status: 422,
          body: {
            error: {
              code: "WIDGET_SITE_KEY_MINTED",
              refusals: [{ code: "WIDGET_SITE_KEY_MINTED", path: "/target/siteKey", detail: "a site key never changes once bound" }],
            },
          },
        };
      return undefined;
    });
    renderWithQuery(<WidgetSettings projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Save widget" }));
    expect(await screen.findByText("WIDGET_SITE_KEY_MINTED: A site key never changes once saved. Reload to restore it.")).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")?.body as { document: { target: { siteKey: string } } };
    expect(put.document.target.siteKey).toBe(SITE_KEY);
  });

  it("shows a saved widget's embed code with its site key, and copies it", async () => {
    world([binding("anonymous")]);
    renderWithQuery(<WidgetSettings projectId="p1" />);
    const embed = await screen.findByTestId("widget-embed");
    expect(within(embed).getByText(SITE_KEY)).toBeInTheDocument();
    expect(within(embed).getByTestId("widget-snippet-embed")).toHaveTextContent(`data-site-key="${SITE_KEY}"`);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(within(embed).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`/widget.js" data-site-key="${SITE_KEY}"`));
    expect(screen.queryByTestId("widget-signing")).toBeNull();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("signed: mints the signing secret through rotate-secret and shows it once, with how to sign", async () => {
    const calls = world([binding("signed")], (call) =>
      call.method === "POST" && call.path === "/projects/p1/integrations/b1/rotate-secret"
        ? { body: { integration: binding("signed"), integrationSecret: "whsec_widget_once", pasteInto: null } }
        : undefined,
    );
    renderWithQuery(<WidgetSettings projectId="p1" />);
    const signing = await screen.findByTestId("widget-signing");
    expect(within(signing).getByTestId("widget-snippet-sign")).toHaveTextContent("createHmac(\"sha256\"");
    expect(within(signing).queryByText("whsec_widget_once")).toBeNull();
    await userEvent.click(within(signing).getByRole("button", { name: "Rotate secret" }));
    expect(await within(signing).findByText("whsec_widget_once")).toBeInTheDocument();
    expect(within(signing).getByText("Shown once")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/rotate-secret"))).toHaveLength(1);
  });
});
