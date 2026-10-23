// The release page a reader sees (REQ-40), read in under a minute: the summary it was cut with and its
// changes counted in one line, what an admin must do first, then each change as its short title, whole,
// with its sentence one click away. No criterion, code or path on the overview; the Technical view keeps
// them. The clip plays from the bytes the session may fetch, inline and muted, opening on its still;
// the technical note is never on a share. A release nobody named says it is being named, or why not.
//
// @direct-test-of packages/web-v2/src/features/releases/components/release-media.tsx
// @direct-test-of packages/web-v2/src/features/releases/components/release-highlights.tsx

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleasePage } from "@forge/contracts/release-page";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReader } from "./release-reader";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const URLS: Blob[] = [];
function stubObjectUrls() {
  URL.createObjectURL = vi.fn((b: Blob) => {
    URLS.push(b);
    return `blob:clip-${URLS.length}`;
  });
  URL.revokeObjectURL = vi.fn();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  URLS.length = 0;
});

/** The row of a change, by the words its row says. */
const changeRow = (text: string) => {
  const row = screen.getAllByTestId("page-change").find((r) => r.textContent?.includes(text));
  if (!row) throw new Error(`no change row says "${text}"`);
  return row;
};
const open = (row: HTMLElement) => fireEvent.click(within(row).getAllByRole("button")[0]);

describe("the lead: the summary it was given and its changes in one line (BC-14)", () => {
  it("opens on the summary it was given, whole, then one counted line, and no count tiles", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const summary = screen.getByTestId("page-summary");
    expect(summary.textContent).toBe(releasePage().header.summary);
    expect(screen.getByTestId("page-tally")).toHaveTextContent("1 new1 fixed");
    expect(screen.getByTestId("page-tally-new")).toHaveAttribute("href", "#release-new");
    expect(screen.queryByTestId("page-glance")).toBeNull();
  });

  it("shows no summary where none was written, drafted or cut: never one derived, never an apology", () => {
    const page = releasePage();
    for (const state of ["draft", "awaiting_approval"] as const) {
      const { unmount } = renderWithQuery(
        <ReleaseReader page={{ ...page, header: { ...page.header, state, name: null, summary: null } }} authed={false} />,
      );
      expect(screen.queryByTestId("page-summary")).toBeNull();
      const header = screen.getByTestId("page-header");
      for (const word of ["This release brings", "when it is cut", "was written"]) expect(header).not.toHaveTextContent(word);
      unmount();
    }
  });

  it("says a release nobody named is being named, or why its name was refused, never a silent blank", async () => {
    const page = releasePage();
    const unnamed = (naming: ReleasePage["header"]["naming"]) => ({ ...page, header: { ...page.header, name: null, summary: null, naming } });
    const { unmount } = renderWithQuery(<ReleaseReader page={unnamed({ state: "drafting", since: "2026-10-23T10:00:00.000Z" })} authed={false} />);
    expect(screen.getByTestId("page-naming-drafting")).toHaveTextContent("Naming this release");
    unmount();
    renderWithQuery(
      <ReleaseReader
        page={unnamed({ state: "failed", at: "2026-10-23T10:00:00.000Z", refusals: [{ code: "RELEASE_NAMING_JARGON", path: "summary", detail: "summary carries criterion BC-3" }] })}
        authed={false}
      />,
    );
    expect(screen.getByTestId("page-naming-failed")).toHaveTextContent("could not be named yet");
    expect(screen.queryByText(/RELEASE_NAMING_JARGON/)).toBeNull();
    await userEvent.click(screen.getByTestId("page-naming-failed-toggle"));
    expect(screen.getByText(/RELEASE_NAMING_JARGON/)).toBeInTheDocument();
  });

  it("groups Security and Removed apart from the fixes and improvements their kinds fold them into", () => {
    const page = releasePage();
    const extra = [
      { issueKey: "ISS-7", kind: "fixed" as const, section: "Security" as const, line: "Reset links stop working once used", detail: null, requirementKey: null },
      { issueKey: "ISS-8", kind: "improved" as const, section: "Removed" as const, line: "The old export button is gone", detail: null, requirementKey: null },
    ];
    renderWithQuery(<ReleaseReader page={{ ...page, fixes: [...page.fixes, ...extra] }} authed={false} />);
    expect(within(screen.getByTestId("page-group-security")).getByText("Reset links stop working once used")).toBeTruthy();
    expect(within(screen.getByTestId("page-group-removed")).getByText("The old export button is gone")).toBeTruthy();
    expect(screen.getByTestId("page-group-fixed")).not.toHaveTextContent("Reset links");
    expect(screen.getByTestId("page-tally")).toHaveTextContent("1 security");
    expect(screen.getByTestId("page-tally")).toHaveTextContent("1 removed");
  });

  it("names exactly the groups the overview draws, in reading order, as one menu control", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const contents = screen.getByTestId("page-contents");
    expect(within(contents).queryAllByRole("link")).toHaveLength(0);
    expect(contents.querySelectorAll("button")).toHaveLength(1);
    await user.click(screen.getByTestId("page-contents-trigger"));
    const items = await screen.findAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.textContent)).toEqual(["Highlights", "Before you release", "New", "Fixed"]);
  });

  it("takes the reader to the group picked from the menu", async () => {
    const user = userEvent.setup();
    const went: string[] = [];
    // jsdom draws no layout and has no scrollIntoView: the double records which group was asked for
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) {
        went.push(this.id);
      },
    });
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    await user.click(screen.getByTestId("page-contents-trigger"));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Before you release" }));
    expect(went).toEqual(["release-admin"]);
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("hides its menu on a wide screen where a rail beside the page lists the contents, and keeps it where none does", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={releasePage()} authed railContents />);
    expect(screen.getByTestId("page-contents").className).toMatch(/(^|\s)lg:hidden(\s|$)/);
    unmount();
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.getByTestId("page-contents").className).not.toMatch(/lg:hidden/);
  });
});

describe("each change as its short title, whole (BC-6)", () => {
  const LONG =
    "You can now save any product to your wishlist from its page or straight from the product grid and your list follows you to every device you sign in on.";

  it("shows a note written before titles as its whole sentence, never cut at a word count or a comma", () => {
    // catalog-api 0.1.0: "Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD" was a row cut at its first comma // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    const legacy = "Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD, sản phẩm đã có được cập nhật tại chỗ thay vì báo lỗi trùng SKU."; // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    renderWithQuery(
      <ReleaseReader
        page={releasePage({
          improvements: [
            { issueKey: "ISS-1", kind: "new", section: "Added", line: LONG, detail: null, requirementKey: null },
            { issueKey: "ISS-3", kind: "improved", section: "Changed", line: legacy, detail: null, requirementKey: null },
          ],
        })}
        authed={false}
      />,
    );
    expect(changeRow("You can now save")).toHaveTextContent(LONG);
    expect(changeRow("Giờ đây")).toHaveTextContent(legacy); // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    expect(screen.getByTestId("release-reader")).not.toHaveTextContent("…");
  });

  it("shows a titled change as its title, and its full sentence with where to read more once opened", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    const row = changeRow("Releases read as pages");
    expect(row).not.toHaveTextContent("in under a minute");
    expect(within(row).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "false");
    open(row);
    const detail = within(row).getByTestId("page-row-detail");
    expect(within(detail).getByTestId("page-row-sentence")).toHaveTextContent("Open any release and read what it brings, whole, in under a minute.");
    expect(within(detail).getByRole("link", { name: "Issue ISS-1" })).toHaveAttribute("href", "/projects/forge/issues/ISS-1");
    expect(within(detail).getByRole("link", { name: "Requirement REQ-40" })).toHaveAttribute("href", "/projects/forge/requirements/REQ-40");
    expect(within(detail).getByRole("link", { name: "Technical details" })).toHaveAttribute("href", "?view=developer#release-technical");
  });

  it("never shows a technical note on a share, nor reads one, nor links into the project", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const row = changeRow("Releases read as pages");
    open(row);
    expect(within(row).getByTestId("page-row-detail")).toBeTruthy();
    expect(within(row).queryByTestId("page-row-technical")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the overview shows no criterion, code, commit or path (BC-15)", () => {
  const CRITERIA = ["The page shows the version and date.", "Known issues are listed.", "Each release has a page.", "0478_release_highlights.sql", "aaaaaaa"];

  it("says no criterion anywhere on the overview, even behind an opened row, and draws no requirement or open-check group", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    for (const row of screen.getAllByTestId("page-change")) open(row);
    const reader = screen.getByTestId("release-reader");
    for (const text of CRITERIA) expect(reader).not.toHaveTextContent(text);
    expect(reader).not.toHaveTextContent("Checks:");
    expect(screen.queryByTestId("page-requirements")).toBeNull();
    expect(screen.queryByTestId("page-known-issues")).toBeNull();
    expect(screen.queryByTestId("page-unnoted")).toBeNull();
  });

  it("keeps each change's criteria, the requirements and what is still open on the Technical view", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed />);
    const row = changeRow("Releases read as pages");
    open(row);
    const detail = within(row).getByTestId("page-row-detail");
    expect(detail).toHaveTextContent("Checks: 3 met, 0 open");
    expect(detail).toHaveTextContent("The page shows the version and date.");
    expect(screen.getByTestId("page-requirements")).toHaveTextContent("Release page");
    expect(screen.getByTestId("page-known-issues")).toBeTruthy();
    expect(screen.getByTestId("page-unnoted")).toHaveTextContent("Rename a helper");
  });

  it("draws seven criteria of one issue as seven lines a reader tells apart", () => {
    // J7 on 0.4.0-dev.222: REQ-34 drew `BC-18 A refusal says…` seven times, under one repeated React key
    const base = releasePage();
    const seven = Array.from({ length: 7 }, (_, i) => ({ code: "BC-18", statement: `refusal ${i + 1} names its field`, short: false, issueKey: "ISS-451", n: i + 1 }));
    const page = {
      ...base,
      view: "developer" as const,
      improvements: [{ issueKey: "ISS-451", kind: "improved" as const, section: "Changed" as const, line: "Refusals name their field", detail: null, requirementKey: "REQ-34" }],
      requirements: [
        { key: "REQ-34", title: "Refusals", completes: false, proven: seven, unproven: 30, business: { total: 26, proven: [{ code: "BC-18", statement: "A refusal says in plain words what to fix, on that field." }] } },
      ],
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithQuery(<ReleaseReader page={page} authed={false} />);
    const row = changeRow("Refusals name their field");
    open(row);
    const lines = [...within(row).getByTestId("page-row-detail").querySelectorAll("li")].map((l) => l.textContent);
    expect(new Set(lines).size).toBe(7);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
  });
});

describe("what nobody using the product sees, counted apart (BC-16)", () => {
  it("counts the internal changes and those with no note in one line on the overview, and lists neither", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    const line = screen.getByTestId("page-internal-line");
    expect(line).toHaveTextContent("1 internal change nobody using the product sees.");
    expect(line).toHaveTextContent("1 change has no note for users.");
    expect(within(line).getByRole("link", { name: "See Technical" })).toHaveAttribute("href", "?view=developer");
    expect(screen.getByTestId("release-reader")).not.toHaveTextContent("Rename a helper");
  });

  it("lists each internal change on the Technical view, saying why it is internal", () => {
    const internal = { count: 2, changes: [
      { issueKey: "ISS-4", title: "admin-rest-v1 declares the deploy report row schema", why: "carries" as const },
      { issueKey: "ISS-9", title: "Publish the admin-rest-v1 contract", why: "skip" as const },
    ] };
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL, internal })} slug="forge" authed />);
    const rows = screen.getAllByTestId("page-internal-row");
    expect(rows.map((r) => r.getAttribute("data-row-key") ?? r.textContent)).toHaveLength(2);
    expect(screen.getByTestId("page-internal")).toHaveTextContent("Carries another change out");
    expect(screen.getByTestId("page-internal")).toHaveTextContent("Internal only");
    expect(screen.queryByTestId("page-internal-line")).toBeNull();
  });
});

describe("before you release (BC-7)", () => {
  it("lists every step an admin must take at the head of the changes, with the issues that name it and no path", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const steps = screen.getAllByTestId("page-action");
    expect(steps.map((s) => s.getAttribute("data-kind"))).toEqual(["step", "migration"]);
    expect(steps[0]).toHaveTextContent("Start a worker on the release-highlights queue.");
    expect(steps[0]).toHaveTextContent("ISS-1");
    expect(screen.getByTestId("page-actions")).not.toHaveTextContent("0478_release_highlights.sql");
    const order = [...screen.getByTestId("release-reader").querySelectorAll("[data-testid='page-actions'], [data-testid^='page-group-']")].map((e) => e.getAttribute("data-testid"));
    expect(order[0]).toBe("page-actions");
  });

  it("names the migration file behind a derived step on the Technical view", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed />);
    expect(screen.getAllByTestId("page-action")[1]).toHaveTextContent("0478_release_highlights.sql");
  });

  it("draws nothing where nothing is asked of an admin", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [] })} authed={false} />);
    expect(screen.queryByTestId("page-actions")).toBeNull();
  });
});

describe("highlights and their clip (BC-2, BC-3)", () => {
  it("fetches an in-app clip with the session's credentials and plays it from the bytes", async () => {
    stubObjectUrls();
    // bytes as a string: Node 22's Response never finishes reading a jsdom Blob, so the clip would never arrive
    const fetchMock = vi.fn(() => Promise.resolve(new Response("webm", { headers: { "content-type": "video/webm" } })));
    vi.stubGlobal("fetch", fetchMock);
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    const video = await screen.findByTestId("release-media-clip");
    expect(video.tagName).toBe("VIDEO");
    // no still was kept beside this clip, so it opens on its own first frame
    expect(video).toHaveAttribute("src", "blob:clip-1#t=0.1");
    expect(video).toHaveAttribute("data-poster", "first-frame");
    expect(video).toHaveAttribute("controls");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/attachments/00000000-0000-4000-8000-000000000001/download");
    expect(init.credentials).toBe("include");
  });

  it("plays a share's clip from its ticket address, with no fetch of its own", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const page = releasePage();
    if (page.highlights.state !== "drafted") throw new Error("fixture");
    const h = page.highlights.highlights[0];
    if (!h?.media) throw new Error("fixture");
    h.media.url = "/api/uploads/download/ticket-abc";
    renderWithQuery(<ReleaseReader page={page} authed={false} />);
    expect(screen.getByTestId("release-media-clip")).toHaveAttribute("src", "/api/uploads/download/ticket-abc#t=0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plays a clip inline and muted, with its controls, opening on the still QA kept beside it (BC-3)", () => {
    const page = releasePage();
    if (page.highlights.state !== "drafted") throw new Error("fixture");
    const h = page.highlights.highlights[0];
    if (!h?.media) throw new Error("fixture");
    h.media.url = "/api/uploads/download/ticket-clip";
    h.media.poster = { attachmentId: "00000000-0000-4000-8000-000000000009", name: "switch-390.png", mime: "image/png", url: "/api/uploads/download/ticket-still" };
    renderWithQuery(<ReleaseReader page={page} authed={false} />);
    const video = screen.getByTestId<HTMLVideoElement>("release-media-clip");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("src", "/api/uploads/download/ticket-clip");
    expect(video).toHaveAttribute("poster", "/api/uploads/download/ticket-still");
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("controls");
    // its text alternative is the highlight's own words, never the file's name
    expect(video).toHaveAttribute("aria-label", h.title);
  });

  it("says so when the clip cannot be fetched, never a blank frame", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("no", { status: 403 }))));
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    expect(await screen.findByTestId("release-media-lost")).toHaveTextContent("could not be loaded");
  });

  it("draws a picture as an image, and says why a highlight has no media where it has none", () => {
    const page = releasePage();
    if (page.highlights.state !== "drafted") throw new Error("fixture");
    const [h] = page.highlights.highlights;
    if (!h?.media) throw new Error("fixture");
    const picture = { ...h, media: { ...h.media, kind: "picture" as const, mime: "image/png" as const, url: "/api/uploads/download/t1" } };
    const bare = { ...h, requirement: { key: "REQ-41", title: "Other" }, media: null, mediaGap: "QA recorded no clip for this build" };
    renderWithQuery(<ReleaseReader page={{ ...page, highlights: { ...page.highlights, highlights: [picture, bare] } }} authed={false} />);
    expect(screen.getByTestId("release-media-picture")).toHaveAttribute("src", "/api/uploads/download/t1");
    expect(screen.getByTestId("page-highlight-gap")).toHaveTextContent(/^No clip$/);
  });

  it("names no criterion code in a highlight's text", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    expect(screen.getByTestId("page-highlight")).not.toHaveTextContent("BC-1");
  });

  it("says a draft is on its way, or failed, with the drafter's refusals behind a fold", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={releasePage({ highlights: { state: "pending", since: "2026-10-09T10:00:00.000Z" } })} authed={false} />);
    expect(screen.getByTestId("page-highlights-pending")).toHaveTextContent("Drafting highlights");
    unmount();
    renderWithQuery(
      <ReleaseReader
        page={releasePage({ highlights: { state: "failed", at: "2026-10-09T10:00:00.000Z", refusals: [{ code: "RELEASE_HIGHLIGHT_UNCLAIMED", path: "highlights.0.claims", detail: "BC-2 has no pass on the build" }] } })}
        authed={false}
      />,
    );
    const failed = screen.getByTestId("page-highlights-failed");
    expect(failed).toHaveTextContent("could not be drafted");
    expect(failed).not.toHaveTextContent("RELEASE_HIGHLIGHT_UNCLAIMED");
    fireEvent.click(screen.getByTestId("page-highlights-failed-toggle"));
    return waitFor(() => expect(failed).toHaveTextContent("RELEASE_HIGHLIGHT_UNCLAIMED"));
  });

  it("draws no highlights section on a release that carries no requirement", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ highlights: { state: "none", why: "no requirement" } })} authed={false} />);
    expect(screen.queryByTestId("page-highlights")).toBeNull();
  });
});

describe("the Technical view (BC-9)", () => {
  it("adds the build, the range, migrations, contracts, dependencies and settings the page carries", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed />);
    const tech = screen.getByTestId("page-technical");
    expect(within(tech).getByTestId("page-technical-migrations")).toHaveTextContent("0478_release_highlights.sql");
    expect(within(tech).getByTestId("page-technical-contracts")).toHaveTextContent("release-page.ts");
    expect(within(tech).getByTestId("page-technical-dependencies")).toHaveTextContent("no new dependency");
    expect(within(tech).getByTestId("page-technical-settings")).toHaveTextContent("PREVIEW_DOMAIN (optional)");
    // where the lists were read from: the range the release run reported, never a silent "None"
    const range = within(tech).getByTestId("page-technical-range");
    expect(range).toHaveTextContent("aaaaaaa");
    expect(range).toHaveTextContent("Read from the range bbbbbbb..aaaaaaa that the release run reported.");
  });

  it("shows an issue's technical note under its row, read off the page it already holds", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed={false} />);
    const row = changeRow("Releases read as pages");
    open(row);
    expect(within(row).getByTestId("page-row-technical")).toHaveTextContent("Reads release-read through sections.ts.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says why the range was not read where the run reported none", () => {
    const why = "the release run did not report what its range bbbbbbb..aaaaaaa ships";
    renderWithQuery(
      <ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL, shipped: { state: "unread", why } })} slug="forge" authed />,
    );
    expect(screen.getByTestId("page-technical-range")).toHaveAttribute("data-read", "unread");
    expect(screen.getByTestId("page-technical-range")).toHaveTextContent(`The range was not read: ${why}.`);
  });

  // J10 on 0.4.0-dev.227: "Deploys UI, API, Logic and Config." read beside the toggle and again under
  // a heading, whose hint said the list was each issue's landing though it is the range's files
  it("says what the release deploys once under its toggle, with no hint that the list is the landings", () => {
    const surface = (s: "ui" | "api") => ({
      surface: s,
      count: 1,
      shipsNothing: false,
      issues: [],
      artifacts: [{ ref: `packages/${s}/a.ts`, change: "changed" as const, issues: [], carriedBy: null }],
    });
    const changes = { ...TECHNICAL.changes, surfaces: [surface("ui"), surface("api")] };
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: { ...TECHNICAL, changes } })} slug="forge" authed />);
    const tech = screen.getByTestId("release-technical");
    fireEvent.click(within(tech).getByTestId("release-technical-toggle"));
    expect(within(tech).getAllByText("Deploys UI and API.")).toHaveLength(1);
    expect(within(tech).getAllByTestId("release-surface")).toHaveLength(2);
    expect(tech).not.toHaveTextContent("landing names");
  });

  it("draws nothing technical for the Overview", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.queryByTestId("page-technical")).toBeNull();
  });
});
