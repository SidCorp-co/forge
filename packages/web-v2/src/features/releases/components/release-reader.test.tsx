// The release page a reader sees (REQ-40), read in thirty seconds: a summary and where it stands
// first, the changes counted by group with each count a link, its contents as one menu, then one short row per
// change whose detail (the full note, the keys, the criteria, the technical note) opens under it. The
// clip plays from the bytes the session may fetch; the technical note is never on a share.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
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

describe("the summary a release opens on", () => {
  it("says what it brings by group, the requirement it completes, its highlights and what is still open", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    const summary = screen.getByTestId("page-summary");
    expect(summary).toHaveAttribute("data-state", "derived");
    expect([...summary.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "This release brings 1 new feature and 1 fix, plus 1 change with no note for users yet.",
      "It completes “Release page”.",
      "Highlights: Every release has a page.",
      "2 acceptance checks are still open on 2 changes.",
    ]);
  });

  it("refuses by name, rather than a filler line, where the release carries nothing to summarise", () => {
    renderWithQuery(
      <ReleaseReader
        page={releasePage({ improvements: [], fixes: [], withoutNotes: [], requirements: [], knownIssues: [], highlights: { state: "none", why: "no requirement" } })}
        authed={false}
      />,
    );
    const summary = screen.getByTestId("page-summary");
    expect(summary).toHaveAttribute("data-state", "refused");
    expect(summary).toHaveAttribute("data-code", "RELEASE_SUMMARY_UNDERIVABLE");
    expect(summary).toHaveTextContent("No summary: release 0.4.0 carries no change and completes or advances no requirement");
  });
});

describe("where the release stands, in one line (BC-1, BC-12)", () => {
  it("says it is live and where, who approved it and what it proved, and never shows the build", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed={false} />);
    const h = screen.getByTestId("page-header");
    expect(h).toHaveTextContent(/Live on https:\/\/forge\.example since /);
    expect(h).toHaveTextContent("Approved by Ada");
    expect(h).toHaveTextContent("Verified: 2 criteria proven");
    expect(h).not.toHaveTextContent("aaaaaaa");
    // an admin step is listed as its own group, so the line does not also speak for it
    expect(h).not.toHaveTextContent(/admin steps/i);
  });

  it("says a draft is not released or deployed, and that approval was not asked", () => {
    const page = releasePage();
    renderWithQuery(
      <ReleaseReader
        page={{ ...page, header: { ...page.header, state: "draft", releasedAt: null, environment: null, build: null, approval: { required: false, state: "not_asked", by: null, at: null } } }}
        authed={false}
      />,
    );
    const h = screen.getByTestId("page-header");
    expect(h).toHaveTextContent("Not released yet, not deployed");
    expect(h).toHaveTextContent("Not asked");
  });

  it("says there is no admin step only where the range was read, and that it was not checked where it was not", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [] })} authed={false} />);
    expect(screen.getByTestId("page-header")).toHaveTextContent("Admin: none");
    expect(screen.queryByTestId("page-actions")).toBeNull();
    unmount();
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [], shipped: { state: "unread", why: "the repository was unreachable" } })} authed={false} />);
    expect(screen.getByTestId("page-header")).toHaveTextContent("Admin steps not checked yet");
    expect(screen.getByTestId("page-header")).not.toHaveTextContent("Admin: none");
    expect(screen.getByTestId("page-header")).not.toHaveTextContent("unreachable");
  });
});

describe("the changes at a glance, and the contents", () => {
  it("counts each group and links a count to its group, leaving an empty group counted and unlinked", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const cell = (k: string) => screen.getByTestId(`page-glance-${k}`);
    const counts = ["new", "improved", "fixed", "security", "other", "open"].map((k) => [k, cell(k).textContent?.replace(/\D/g, "")]);
    expect(counts).toEqual([["new", "1"], ["improved", "0"], ["fixed", "1"], ["security", "0"], ["other", "1"], ["open", "2"]]);
    expect(cell("new")).toHaveAttribute("href", "#release-new");
    expect(cell("open")).toHaveAttribute("href", "#release-open");
    expect(cell("improved")).not.toHaveAttribute("href");
    // the row knows its six cells, so it wraps into even lines (six, three a line, two a line) and never five over one
    expect(screen.getByTestId("page-glance-row").style.getPropertyValue("--stat-track")).toContain("(660px - 100%)");
    // every link lands on a group that is on the page
    for (const k of ["new", "fixed", "other", "open"]) {
      const target = cell(k).getAttribute("href")?.slice(1) ?? "";
      expect(document.getElementById(target)).not.toBeNull();
    }
  });

  it("groups a Security entry apart from the fixes its kind folds it into", () => {
    const page = releasePage();
    renderWithQuery(
      <ReleaseReader page={{ ...page, fixes: [...page.fixes, { issueKey: "ISS-7", kind: "fixed", section: "Security", line: "Reset links stop working once used." }] }} authed={false} />,
    );
    expect(screen.getByTestId("page-glance-security").textContent).toMatch(/1$/);
    expect(screen.getByTestId("page-glance-fixed").textContent).toMatch(/1$/);
    expect(within(screen.getByTestId("page-group-security")).getByText("Reset links stop working once used")).toBeTruthy();
    expect(screen.getByTestId("page-group-fixed")).not.toHaveTextContent("Reset links");
  });

  it("names exactly the groups the page draws, in reading order, as one menu control and never a row of links", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const contents = screen.getByTestId("page-contents");
    expect(within(contents).queryAllByRole("link")).toHaveLength(0);
    expect(contents.querySelectorAll("button")).toHaveLength(1);
    await user.click(screen.getByTestId("page-contents-trigger"));
    const items = await screen.findAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.textContent)).toEqual(["Highlights", "New features", "Fixes", "Requirements", "Still open", "Other changes", "Admin steps"]);
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
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Still open" }));
    expect(went).toEqual(["release-open"]);
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

describe("each change as one short row (BC-6)", () => {
  const LONG =
    "You can now save any product to your wishlist from its page or straight from the product grid and your list follows you to every device you sign in on.";

  it("says at most fifteen words, and the full line only once the row is opened", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ improvements: [{ issueKey: "ISS-1", kind: "new", section: "Added", line: LONG }] })} authed={false} />);
    const row = changeRow("You can now save");
    const title = row.querySelector("button span span")?.textContent ?? "";
    expect(title.replace(/…$/, "").split(/\s+/)).toHaveLength(15);
    expect(title.endsWith("…")).toBe(true);
    expect(row).not.toHaveTextContent("every device");
    open(row);
    expect(within(row).getByTestId("page-row-detail")).toHaveTextContent(LONG);
  });

  it("shows no criterion, no requirement and no note behind a row until it is opened, then each with its links", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    const row = changeRow("Releases read as pages");
    expect(row).not.toHaveTextContent("The page shows the version and date.");
    expect(within(row).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    open(row);
    expect(within(row).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");
    const detail = within(row).getByTestId("page-row-detail");
    expect(detail).toHaveTextContent("Checks: 3 passed, 0 open");
    expect(detail).toHaveTextContent("The page shows the version and date.");
    expect(within(detail).getByRole("link", { name: "Issue ISS-1" })).toHaveAttribute("href", "/projects/forge/issues/ISS-1");
    expect(within(detail).getByRole("link", { name: "Requirement REQ-40" })).toHaveAttribute("href", "/projects/forge/requirements/REQ-40");
  });

  it("never shows a technical note on a share, nor reads one", () => {
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

  it("reads a member's technical note from the Technical view only when the row is opened", async () => {
    const calls = fakeCore((c) => (c.path === "/projects/p1/releases/0.4.0/page?view=developer" ? { body: releasePage({ view: "developer", technical: TECHNICAL }) } : undefined));
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed />);
    expect(calls.filter((c) => c.path.includes("view=developer"))).toHaveLength(0);
    const row = changeRow("Releases read as pages");
    open(row);
    expect(await within(row).findByTestId("page-row-technical")).toHaveTextContent("Reads release-read through sections.ts.");
    expect(calls.filter((c) => c.path.includes("view=developer"))).toHaveLength(1);
  });

  it("draws seven criteria of one issue as seven lines a reader tells apart", () => {
    // J7 on 0.4.0-dev.222: REQ-34 drew `BC-18 A refusal says…` seven times, under one repeated React key
    const base = releasePage();
    const seven = Array.from({ length: 7 }, (_, i) => ({ code: "BC-18", statement: `refusal ${i + 1} names its field`, short: false, issueKey: "ISS-451", n: i + 1 }));
    const page = {
      ...base,
      view: "developer" as const,
      improvements: [{ issueKey: "ISS-451", kind: "improved" as const, section: "Changed" as const, line: "Refusals name their field." }],
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

describe("requirements, still open and other changes (BC-5, BC-8)", () => {
  it("draws a requirement as one row, its own criteria proven only behind it", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    const r = screen.getByTestId("page-requirement");
    expect(r).toHaveTextContent("Completes");
    expect(r).toHaveTextContent("Release page");
    expect(r).toHaveTextContent("Checks passed: 3");
    expect(within(r).queryByTestId("page-requirement-count")).toBeNull();
    open(r);
    const count = within(r).getByTestId("page-requirement-count");
    expect(count).toHaveTextContent("2 of its 13 criteria proven");
    expect(r).toHaveTextContent("Each release has a page.");
    expect(within(r).getByRole("link", { name: "Requirement REQ-40" })).toHaveAttribute("href", "/projects/forge/requirements/REQ-40");
  });

  it("draws one row per issue with criteria still open, each criterion as what it is behind it", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const rows = screen.getAllByTestId("page-known-issue");
    expect(rows.map((r) => r.getAttribute("data-row-key"))).toEqual(["ISS-3", "ISS-4"]);
    expect(rows[0]).toHaveTextContent("1 open");
    expect(rows[0]).not.toHaveTextContent("Known issues are listed.");
    open(rows[0]);
    expect(rows[0]).toHaveTextContent("Known issues are listed. (Falls short)");
    open(rows[1]);
    expect(rows[1]).toHaveTextContent("A developer view adds notes. (Not yet judged)");
  });

  // BC-11: the user view says the criterion's words and its state; QA's reason and the other build
  // it was judged on are the Technical view's, even where the page carries them
  it("shows QA's reason and the other build in the Technical view only", () => {
    const page = releasePage();
    const carried = page.knownIssues.map((k) => ({ ...k, reason: k.reason ?? "judged on another commit", elsewhere: k.elsewhere ?? { verdict: "pass" as const, commitSha: "b".repeat(40) } }));
    const user = renderWithQuery(<ReleaseReader page={{ ...page, view: "user", knownIssues: carried }} authed={false} />);
    for (const r of screen.getAllByTestId("page-known-issue")) open(r);
    expect(screen.getByTestId("page-known-issues")).not.toHaveTextContent("the list is empty on mobile");
    expect(screen.getByTestId("page-known-issues")).not.toHaveTextContent("bbbbbbb");
    user.unmount();
    renderWithQuery(<ReleaseReader page={{ ...page, view: "developer", knownIssues: carried }} authed={false} />);
    const rows = screen.getAllByTestId("page-known-issue");
    for (const r of rows) open(r);
    expect(rows[0]).toHaveTextContent("the list is empty on mobile");
    expect(rows[1]).toHaveTextContent("Judged pass on build bbbbbbb instead");
  });

  it("draws no Still open group where nothing is open, and counts it as nothing to follow", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ knownIssues: [] })} authed={false} />);
    expect(screen.queryByTestId("page-known-issues")).toBeNull();
    expect(screen.getByTestId("page-glance-open")).not.toHaveAttribute("href");
  });

  it("names the changes with no note for users, and one reworked in a later release, by their titles", () => {
    const page = releasePage();
    renderWithQuery(<ReleaseReader page={{ ...page, withoutNotes: [...page.withoutNotes, { issueKey: "ISS-455", title: "Intake drafts", why: "reworked" }] }} authed={false} />);
    const rows = within(screen.getByTestId("page-unnoted")).getAllByTestId("page-unnoted-row");
    expect(rows[0]).toHaveTextContent("Rename a helper");
    expect(rows[0]).toHaveTextContent("no note yet");
    expect(rows[1]).toHaveTextContent("Intake drafts");
    expect(rows[1]).toHaveTextContent("reworked in a later release");
  });
});

describe("admin steps (BC-7)", () => {
  it("says what an admin must do, naming the artifact that owes it", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.getByTestId("page-action")).toHaveTextContent("Run the database migration before opening the app.");
    expect(screen.getByTestId("page-action")).toHaveTextContent("0478_release_highlights.sql");
  });

  // J10 on 0.4.0-dev.227: each ask printed its migration path twice, in the sentence and under it
  it("names an ask's artifact once where its sentence already says it", () => {
    const ref = "packages/core/drizzle/migrations/0495_intake_retry.sql";
    const sentence = `Back up the database before this release deploys: ${ref} changes its schema.`;
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [{ kind: "migration", sentence, ref, issues: ["ISS-455"] }] })} authed={false} />);
    expect(screen.getByTestId("page-action").textContent?.split(ref)).toHaveLength(2);
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
    expect(video).toHaveAttribute("src", "blob:clip-1");
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
    expect(screen.getByTestId("release-media-clip")).toHaveAttribute("src", "/api/uploads/download/ticket-abc");
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("page-highlight-gap")).toHaveTextContent("No clip: QA recorded no clip for this build");
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
