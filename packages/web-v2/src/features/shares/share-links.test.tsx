import type { ShareAudienceOption, ShareLinkView } from "@forge/contracts/shares";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { ShareAction } from "./components/share-action";
import { ShareDialog } from "./components/share-dialog";
import { ShareList } from "./components/share-list";

// A person shares one answer from its own row, picks who may open it and for how long, and is shown
// the link once; a project lists its links, each with where it stands, and revokes one. Which
// audience is open, and every refusal, is core's answer by its code, never the screen's guess.

const ME = "u-me";
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = "11111111-1111-4111-8111-111111111111";
const TOKEN = `forge_share_${"t".repeat(43)}`;
const URL_ONCE = `https://forge.test/s/${TOKEN}`;

const open = (audience: ShareAudienceOption["audience"]): ShareAudienceOption => ({ audience, refusal: null });
const refused = (audience: ShareAudienceOption["audience"], code: string, message: string): ShareAudienceOption => ({
  audience,
  refusal: { code, message },
});

const envelope = (status: number, code: string, detail: string) => ({
  status,
  body: { code, message: `refused, nothing written: ${code} at /: ${detail}`, detail, error: { code, message: detail, refusals: [{ code, path: "", detail }] } },
});

function view(over: Partial<ShareLinkView> = {}): ShareLinkView {
  return {
    id: "s-1",
    projectId: P,
    audience: "members",
    subjectKind: "message",
    title: "Progress by requirement",
    createdBy: ME,
    createdAt: "2026-10-08T03:50:00.000Z",
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    revokedAt: null,
    revokedBy: null,
    viewCount: 2,
    lastViewedAt: "2026-10-08T04:00:00.000Z",
    ...over,
  };
}

/** A core answering the audiences read, and a create the test decides. */
function dialogCore(audiences: ShareAudienceOption[], onCreate: (call: Call) => { status?: number; body: unknown } = () => ({ status: 201, body: { share: view(), url: URL_ONCE } })) {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === `/projects/${P}/shares/audiences`) return { body: { audiences } };
    if (call.method === "POST" && call.path === `/projects/${P}/shares`) return onCreate(call);
    if (call.method === "GET" && call.path === `/projects/${P}/shares`) return { body: { shares: [] } };
    return undefined;
  });
}

const radio = (name: string) => screen.getByRole("radio", { name });
const createButton = () => screen.getByRole("button", { name: "Create link" });

describe("the share dialog", () => {
  const dialog = () => renderWithQuery(<ShareDialog projectId={P} subject={{ kind: "message", id: "m3" }} onClose={() => {}} />);

  it("starts at project members for seven days, and sends what was chosen", async () => {
    const calls = dialogCore([open("members"), open("link")]);
    dialog();
    expect(radio("Project members")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("spinbutton")).toHaveValue(7);
    await waitFor(() => expect(radio("Anyone with the link")).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(createButton());
    await screen.findByTestId("share-created");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ subjectKind: "message", subjectId: "m3", audience: "members", expiresInDays: 7 });
  });

  it("refuses more than thirty days by name and creates nothing, and takes thirty", async () => {
    const calls = dialogCore([open("members"), open("link")]);
    dialog();
    await waitFor(() => expect(createButton()).toBeEnabled());
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "31" } });
    expect(screen.getByText("A share expires within 30 days at most.")).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    expect(createButton()).toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
    fireEvent.click(radio("Anyone with the link"));
    fireEvent.click(createButton());
    await screen.findByTestId("share-created");
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ audience: "link", expiresInDays: 30 });
  });

  it("disables anyone-with-the-link with core's code and sentence when the permission is not held", async () => {
    const why = "creating a share open to anyone holding its link needs shares.public on this project";
    dialogCore([open("members"), refused("link", "PERMISSION_FORBIDDEN", why)]);
    dialog();
    const reason = await screen.findByTestId("share-audience-link-reason");
    expect(reason).toHaveTextContent(`PERMISSION_FORBIDDEN: ${why}`);
    expect(radio("Anyone with the link")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Project members")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("disables it naming the data policy when the project keeps its data from leaving", async () => {
    const why = "project p keeps its data from leaving (data policy no_egress)";
    dialogCore([open("members"), refused("link", "SHARE_EGRESS_FORBIDDEN", why)]);
    dialog();
    expect(await screen.findByTestId("share-audience-link-reason")).toHaveTextContent(`SHARE_EGRESS_FORBIDDEN: ${why}`);
    expect(radio("Anyone with the link")).toHaveAttribute("aria-disabled", "true");
  });

  it("offers the link audience only once core has answered, and names a read that failed", async () => {
    dialogCore([]);
    vi.unstubAllGlobals();
    fakeCore((call) => (call.path.endsWith("/audiences") ? envelope(503, "SERVICE_UNAVAILABLE", "core is restarting") : undefined));
    dialog();
    expect(radio("Anyone with the link")).toHaveAttribute("aria-disabled", "true");
    const failed = await screen.findByTestId("share-refusal");
    expect(failed).toHaveTextContent("SERVICE_UNAVAILABLE: core is restarting");
    expect(radio("Anyone with the link")).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the link once, and never again after the dialog closes", async () => {
    const calls = dialogCore([open("members"), open("link")]);
    renderWithQuery(<ShareAction projectId={P} subject={{ kind: "message", id: "m3" }} />);
    fireEvent.click(screen.getByTestId("message-share"));
    await waitFor(() => expect(createButton()).toBeEnabled());
    fireEvent.click(createButton());
    expect(await screen.findByTestId("share-link")).toHaveValue(URL_ONCE);
    expect(screen.getByTestId("share-created-title")).toHaveTextContent("Progress by requirement");
    expect(screen.getByText(/This link is shown once/)).toBeInTheDocument();
    expect(screen.getAllByDisplayValue(URL_ONCE)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("share-created")).toBeNull());
    fireEvent.click(screen.getByTestId("message-share"));
    await screen.findByTestId("share-dialog");
    expect(screen.queryByTestId("share-link")).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["SHARE_SUBJECT_UNSUPPORTED", 422, "a message cannot be shared yet: no source that freezes a message is registered in this build"],
    ["REPORT_RUN_NOT_FOUND", 404, "run r-9 is not one you can read now"],
    ["PERMISSION_FORBIDDEN", 403, "creating a share needs shares.write on this project"],
    ["SHARE_EGRESS_FORBIDDEN", 403, "project p keeps its data from leaving (data policy no_egress)"],
  ])("renders core's refusal %s by name with core's sentence", async (code, status, detail) => {
    dialogCore([open("members"), open("link")], () => envelope(status, code, detail));
    dialog();
    await waitFor(() => expect(createButton()).toBeEnabled());
    fireEvent.click(createButton());
    const refusal = await screen.findByTestId("share-refusal");
    expect(refusal.getAttribute("data-code")).toBe(code);
    expect(refusal).toHaveTextContent(`${code}: ${detail}`);
    expect(screen.queryByTestId("share-created")).toBeNull();
  });
});

describe("a project's share links", () => {
  const names = (id: string) => ({ [ME]: "An Nguyen", "u-binh": "Binh Tran" })[id] ?? null;
  const list = (isAdmin = false) => renderWithQuery(<ShareList projectId={P} nameOf={names} isAdmin={isAdmin} />);

  it("reads each row's state as a badge, offers Revoke on the reader's own active link, and shows no token", async () => {
    const shares = [
      view({ id: "s-mine" }),
      view({ id: "s-theirs", createdBy: "u-binh", audience: "link" }),
      view({ id: "s-old", expiresAt: "2026-10-01T00:00:00.000Z" }),
      view({ id: "s-gone", revokedAt: "2026-10-08T05:00:00.000Z", revokedBy: ME }),
      view({ id: "s-left", createdBy: "u-left", subjectKind: "template-output" }),
    ];
    fakeCore((call) => (call.method === "GET" && call.path === `/projects/${P}/shares` ? { body: { shares } } : undefined));
    list();
    await screen.findByTestId("share-list");
    const rows = screen.getAllByTestId("share-row");
    const state = (id: string) => rows.find((r) => r.getAttribute("data-share-id") === id) as HTMLElement;
    const badge = (id: string) => within(state(id)).getAllByTestId("enum-badge").at(-1);
    expect(badge("s-mine")).toHaveTextContent("Active");
    expect(badge("s-old")).toHaveTextContent("Expired");
    expect(badge("s-gone")).toHaveTextContent("Revoked");
    expect(within(state("s-theirs")).getByText("Anyone with the link")).toBeInTheDocument();
    expect(within(state("s-left")).getByText("Former member")).toBeInTheDocument();
    expect(screen.getAllByTestId("share-revoke").map((b) => b.closest("tr")?.getAttribute("data-share-id"))).toEqual(["s-mine"]);
    expect(document.body.textContent).not.toMatch(/forge_share_|tokenHash/);
  });

  it("tells two links of one kind apart by the title each froze, and the dialog names the same one", async () => {
    const shares = [view({ id: "s-a", title: "Progress by requirement" }), view({ id: "s-b", title: "Open risks" }), view({ id: "s-c", title: null })];
    fakeCore((call) => (call.method === "GET" ? { body: { shares } } : undefined));
    list();
    await screen.findByTestId("share-list");
    expect(screen.getAllByTestId("share-title").map((t) => `${t.closest("tr")?.getAttribute("data-share-id")}:${t.textContent}`)).toEqual([
      "s-a:Progress by requirement",
      "s-b:Open risks",
    ]);
  });

  it("offers a project admin Revoke on every active link", async () => {
    const shares = [view({ id: "s-mine" }), view({ id: "s-theirs", createdBy: "u-binh" })];
    fakeCore((call) => (call.method === "GET" ? { body: { shares } } : undefined));
    list(true);
    await screen.findByTestId("share-list");
    expect(screen.getAllByTestId("share-revoke")).toHaveLength(2);
  });

  const revokeFlow = async (afterRevoke: ShareLinkView) => {
    let reads = 0;
    const calls = fakeCore((call) => {
      if (call.method === "GET" && call.path === `/projects/${P}/shares`) {
        reads += 1;
        return { body: { shares: [reads === 1 ? view() : afterRevoke] } };
      }
      if (call.method === "POST" && call.path === `/projects/${P}/shares/s-1/revoke`) {
        return { body: { share: view({ revokedAt: "2026-10-08T06:00:00.000Z", revokedBy: ME }) } };
      }
      return undefined;
    });
    list();
    await screen.findByTestId("share-list");
    fireEvent.click(screen.getByTestId("share-revoke"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
    return calls;
  };

  it("reads the list again after a revoke, and the row reads revoked from that read", async () => {
    await revokeFlow(view({ revokedAt: "2026-10-08T06:00:00.000Z", revokedBy: ME }));
    await waitFor(() => expect(screen.getByTestId("share-row").getAttribute("data-state")).toBe("revoked"));
    expect(screen.queryByTestId("share-revoke")).toBeNull();
  });

  it("does not draw a revocation the list read does not hold", async () => {
    await revokeFlow(view());
    await waitFor(() => expect(screen.getByTestId("share-row").getAttribute("data-state")).toBe("active"));
  });

  it("names core's refusal to revoke", async () => {
    const detail = "share s-1 is revoked only by the person who created it or a project admin; the caller is neither";
    fakeCore((call) => {
      if (call.method === "GET") return { body: { shares: [view()] } };
      return envelope(403, "SHARE_REVOKE_FORBIDDEN", detail);
    });
    list();
    await screen.findByTestId("share-list");
    fireEvent.click(screen.getByTestId("share-revoke"));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const refusal = await screen.findByTestId("share-refusal");
    expect(refusal).toHaveTextContent(`SHARE_REVOKE_FORBIDDEN: ${detail}`);
    expect(screen.getByTestId("share-row").getAttribute("data-state")).toBe("active");
  });
});
