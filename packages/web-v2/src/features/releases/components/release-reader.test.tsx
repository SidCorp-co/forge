// The release page a reader sees (REQ-40): each section from the page core served, the truth rule's
// known issues in plain words, the clip played from the bytes the session may fetch, and the
// technical notes only where the page carries them.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReader } from "./release-reader";

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

describe("the reader's header (BC-1, BC-12)", () => {
  it("heads with when it was released, where it runs, the build, how it was verified and who approved it", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    const h = screen.getByTestId("page-header");
    expect(within(h).getByTestId("page-header-runs-at")).toHaveTextContent("https://forge.example");
    expect(within(h).getByTestId("page-header-build")).toHaveTextContent("aaaaaaa");
    expect(within(h).getByTestId("page-header-verified")).toHaveTextContent("Verified: 2 criteria proven");
    expect(within(h).getByTestId("page-header-approval")).toHaveTextContent(/^ApprovalApproved by Ada, /);
    expect(within(h).getByTestId("page-header-released")).not.toHaveTextContent("Not released yet");
  });

  it("says approval was not asked, and that a draft has no build, rather than leaving the rows blank", () => {
    const page = releasePage();
    renderWithQuery(
      <ReleaseReader
        page={{ ...page, header: { ...page.header, state: "draft", releasedAt: null, environment: null, build: null, approval: { required: false, state: "not_asked", by: null, at: null } } }}
        authed={false}
      />,
    );
    expect(screen.getByTestId("page-header-approval")).toHaveTextContent("Not asked");
    expect(screen.getByTestId("page-header-build")).toHaveTextContent("Not cut yet");
    expect(screen.getByTestId("page-header-released")).toHaveTextContent("Not released yet");
    expect(screen.getByTestId("page-header-runs-at")).toHaveTextContent("Not deployed");
  });
});

describe("the sections the release page reads (BC-5..8)", () => {
  it("lists the requirement with the criterion it proves live and what is not yet proven", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} slug="forge" authed={false} />);
    const r = screen.getByTestId("page-requirement");
    expect(r).toHaveTextContent("REQ-40");
    // counted in the requirement's own criteria, each proven one said once with the rows proving it
    expect(within(r).getByTestId("page-requirement-count")).toHaveTextContent("2 of its 13 criteria proven on this build");
    const codes = within(r).getAllByTestId("page-proven-code");
    expect(codes.map((c) => c.getAttribute("data-code"))).toEqual(["BC-1", "BC-2"]);
    expect(codes[0]).toHaveTextContent("BC-1Each release has a page.");
    expect(within(codes[0] as HTMLElement).getAllByTestId("page-proven-row").map((row) => row.textContent)).toEqual([
      "ISS-1 #1The page shows the version and date.",
      "ISS-1 #2The page names who approved it.",
    ]);
    // a criterion met but short of its wording is proven and says so, beside it
    expect(within(r).getAllByTestId("page-proven-short")).toHaveLength(1);
    expect(codes[1]).toHaveTextContent("ISS-1 #3Each release opens on highlights.short of its wording");
    expect(within(r).queryByTestId("page-unproven")).toBeNull();
    expect(within(r).getByRole("link", { name: "REQ-40" })).toHaveAttribute("href", "/projects/forge/requirements/REQ-40");
  });

  it("draws seven criteria proving one requirement criterion as seven rows a reader tells apart", () => {
    // J7 on 0.4.0-dev.222: REQ-34 drew `BC-18 A refusal says…` seven times, under one repeated React key
    const base = releasePage();
    const seven = Array.from({ length: 7 }, (_, i) => ({ code: "BC-18", statement: `refusal ${i + 1} names its field`, short: false, issueKey: "ISS-451", n: i + 1 }));
    const page = {
      ...base,
      requirements: [
        { key: "REQ-34", title: "Refusals", completes: false, proven: seven, unproven: 30, business: { total: 26, proven: [{ code: "BC-18", statement: "A refusal says in plain words what to fix, on that field." }] } },
      ],
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithQuery(<ReleaseReader page={page} authed={false} />);
    const r = screen.getByTestId("page-requirement");
    expect(within(r).getAllByText("A refusal says in plain words what to fix, on that field.")).toHaveLength(1);
    const rows = within(r).getAllByTestId("page-proven-row").map((row) => row.textContent);
    expect(new Set(rows).size).toBe(7);
    expect(within(r).getByTestId("page-requirement-count")).toHaveTextContent("1 of its 26 criteria proven on this build");
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("splits improvements from fixes in the user's words, with no issue key", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(within(screen.getByTestId("page-improvements")).getByText("Releases read as pages.")).toBeTruthy();
    expect(within(screen.getByTestId("page-fixes")).getByText("Dates show correctly.")).toBeTruthy();
    expect(screen.getByTestId("page-changes")).not.toHaveTextContent("ISS-1");
  });

  it("names the changes that have no note for users, behind a fold", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const unnoted = screen.getByTestId("page-unnoted");
    expect(unnoted).toHaveTextContent("1 change has no note for users");
    expect(within(unnoted).queryByText("Rename a helper")).toBeNull();
    screen.getByTestId("page-unnoted-toggle").click();
    return waitFor(() => expect(within(unnoted).getByText(/Rename a helper/)).toBeTruthy());
  });

  it("names an issue reworked in a later release instead of showing its later line", () => {
    const page = releasePage();
    renderWithQuery(
      <ReleaseReader
        page={{ ...page, withoutNotes: [{ issueKey: "ISS-455", title: "Intake drafts", why: "reworked" }] }}
        authed={false}
      />,
    );
    screen.getByTestId("page-unnoted-toggle").click();
    return waitFor(() => expect(screen.getByTestId("page-unnoted")).toHaveTextContent("Intake drafts (reworked in a later release)"));
  });

  it("says what an admin must do, naming the artifact that owes it, or that nothing is required", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.getByTestId("page-action")).toHaveTextContent("Run the database migration before opening the app.");
    expect(screen.getByTestId("page-action")).toHaveTextContent("0478_release_highlights.sql");
    unmount();
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [] })} authed={false} />);
    expect(screen.getByTestId("page-actions")).toHaveTextContent("Nothing is required of you.");
  });

  // J10 on 0.4.0-dev.227: each ask printed its migration path twice, in the sentence and under it
  it("names an ask's artifact once where its sentence already says it", () => {
    const ref = "packages/core/drizzle/migrations/0495_intake_retry.sql";
    const sentence = `Back up the database before this release deploys: ${ref} changes its schema.`;
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [{ kind: "migration", sentence, ref, issues: ["ISS-455"] }] })} authed={false} />);
    expect(screen.getByTestId("page-action").textContent?.split(ref)).toHaveLength(2);
  });

  it("lists each criterion not proven on the build as what it is: short, not judged and where it was judged instead", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    const rows = screen.getAllByTestId("page-known-issue");
    expect(rows.map((r) => r.getAttribute("data-standing"))).toEqual(["short", "not_judged"]);
    expect(rows[0]).toHaveTextContent("Falls short");
    expect(rows[1]).toHaveTextContent("Not yet judged");
  });

  // BC-11: the user view says the criterion's words and its state; QA's reason and the other build
  // it was judged on are the developer view's, even where the page carries them
  it("shows QA's reason and the other build in the developer view only", () => {
    const page = releasePage();
    const carried = page.knownIssues.map((k) => ({ ...k, reason: k.reason ?? "judged on another commit", elsewhere: k.elsewhere ?? { verdict: "pass" as const, commitSha: "b".repeat(40) } }));
    const user = renderWithQuery(<ReleaseReader page={{ ...page, view: "user", knownIssues: carried }} authed={false} />);
    expect(screen.getByTestId("page-known-issues")).not.toHaveTextContent("the list is empty on mobile");
    expect(screen.getByTestId("page-known-issues")).not.toHaveTextContent("bbbbbbb");
    user.unmount();
    renderWithQuery(<ReleaseReader page={{ ...page, view: "developer", knownIssues: carried }} authed={false} />);
    const rows = screen.getAllByTestId("page-known-issue");
    expect(rows[0]).toHaveTextContent("the list is empty on mobile");
    expect(rows[1]).toHaveTextContent("Judged pass on build bbbbbbb instead");
  });

  it("says a range it could not read, never that nothing is required", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ actionRequired: [], shipped: { state: "unread", why: "the repository was unreachable" } })} authed={false} />);
    expect(screen.getByTestId("page-actions-none")).toHaveTextContent("could not be read: the repository was unreachable.");
    expect(screen.getByTestId("page-actions")).not.toHaveTextContent("Nothing is required of you.");
  });

  it("says no known issues where there are none, never leaving the section silent", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ knownIssues: [] })} authed={false} />);
    expect(screen.getByTestId("page-known-issues")).toHaveTextContent("No known issues on this build.");
  });
});

describe("highlights and their clip (BC-2, BC-3)", () => {
  it("fetches an in-app clip with the session's credentials and plays it from the bytes", async () => {
    stubObjectUrls();
    // bytes as a string: Node 22's Response never finishes reading a jsdom Blob, so the clip would never arrive
    const fetchMock = vi.fn(async () => new Response("webm", { headers: { "content-type": "video/webm" } }));
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
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
    expect(screen.getByTestId("page-highlight-gap")).toHaveTextContent("No clip or picture: QA recorded no clip for this build");
  });

  it("says a draft is on its way, or failed with the refusals it earned, instead of showing nothing", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={releasePage({ highlights: { state: "pending", since: "2026-10-09T10:00:00.000Z" } })} authed={false} />);
    expect(screen.getByTestId("page-highlights-pending")).toHaveTextContent("Drafting highlights");
    unmount();
    renderWithQuery(
      <ReleaseReader
        page={releasePage({ highlights: { state: "failed", at: "2026-10-09T10:00:00.000Z", refusals: [{ code: "RELEASE_HIGHLIGHT_UNCLAIMED", path: "highlights.0.claims", detail: "BC-2 has no pass on the build" }] } })}
        authed={false}
      />,
    );
    expect(screen.getByTestId("page-highlights-failed")).toHaveTextContent("could not be drafted");
    expect(screen.getByTestId("page-highlights-failed")).toHaveTextContent("RELEASE_HIGHLIGHT_UNCLAIMED");
  });

  it("draws no highlights section on a release that carries no requirement", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ highlights: { state: "none", why: "no requirement" } })} authed={false} />);
    expect(screen.queryByTestId("page-highlights")).toBeNull();
  });
});

describe("the developer view (BC-9)", () => {
  it("adds the technical notes, migrations, contracts and dependencies the page carries", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ view: "developer", technical: TECHNICAL })} slug="forge" authed />);
    const tech = screen.getByTestId("page-technical");
    expect(within(tech).getByTestId("page-technical-notes")).toHaveTextContent("Reads release-read through sections.ts.");
    expect(within(tech).getByTestId("page-technical-migrations")).toHaveTextContent("0478_release_highlights.sql");
    expect(within(tech).getByTestId("page-technical-contracts")).toHaveTextContent("release-page.ts");
    expect(within(tech).getByTestId("page-technical-dependencies")).toHaveTextContent("no new dependency");
    expect(within(tech).getByTestId("page-technical-settings")).toHaveTextContent("PREVIEW_DOMAIN (optional)");
    // where the lists were read from: the range the release run reported, never a silent "None"
    expect(within(tech).getByTestId("page-technical-range")).toHaveTextContent("Read from the range bbbbbbb..aaaaaaa that the release run reported.");
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

  it("draws nothing technical for the user view", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.queryByTestId("page-technical")).toBeNull();
  });
});
