import type { ReleasePage } from "@forge/contracts/release-page";

export const BUILD = "a".repeat(40);

/** A release page as core serves it for a shipped release: every user section filled, one clip, one known issue. */
export function releasePage(over: Partial<ReleasePage> = {}): ReleasePage {
  return {
    view: "user",
    projectId: "p1",
    header: {
      version: "0.4.0",
      name: "Readable releases",
      summary: "Every release now opens as a page you can read in a minute. Each change is named in a short title and one sentence.",
      state: "shipped",
      releasedAt: "2026-10-09T10:00:00.000Z",
      environment: { name: "production", url: "https://forge.example" },
      build: BUILD,
      verified: { level: "criteria", proven: 2, total: 3, check: null, provider: null, judgedOn: null },
      approval: { required: true, state: "approved", by: { id: "u1", name: "Ada", kind: "human" }, at: "2026-10-09T09:00:00.000Z" },
      shippedFailing: null,
      recordedNotCut: false,
    },
    highlights: {
      state: "drafted",
      model: "m",
      draftedAt: "2026-10-09T10:00:00.000Z",
      sourceDigest: "d",
      highlights: [
        {
          requirement: { key: "REQ-40", title: "Release page" },
          title: "Every release has a page",
          body: "Open a release and read what changed.",
          claims: ["BC-1"],
          media: {
            kind: "clip",
            attachmentId: "00000000-0000-4000-8000-000000000001",
            name: "page.webm",
            mime: "video/webm",
            bytes: 10,
            verdictId: "00000000-0000-4000-8000-000000000002",
            issueKey: "ISS-1",
            criterion: { n: 1, bc: "BC-1" },
            commitSha: BUILD,
            url: "/api/attachments/00000000-0000-4000-8000-000000000001/download",
          },
        },
      ],
    },
    requirements: [
      {
        key: "REQ-40",
        title: "Release page",
        completes: true,
        proven: [
          { code: "BC-1", statement: "The page shows the version and date.", short: false, issueKey: "ISS-1", n: 1, countedUnderCutover: false },
          { code: "BC-1", statement: "The page names who approved it.", short: false, issueKey: "ISS-1", n: 2, countedUnderCutover: false },
          { code: "BC-2", statement: "Each release opens on highlights.", short: true, issueKey: "ISS-1", n: 3, countedUnderCutover: false },
        ],
        unproven: 1,
        business: {
          total: 13,
          proven: [
            { code: "BC-1", statement: "Each release has a page." },
            { code: "BC-2", statement: "The page opens on highlights." },
          ],
        },
      },
    ],
    untraced: null,
    improvements: [
      {
        issueKey: "ISS-1",
        kind: "new",
        section: "Added",
        line: "Releases read as pages",
        detail: "Open any release and read what it brings, whole, in under a minute.",
        requirementKey: "REQ-40",
        ui: true,
        visual: {
          desktop: { attachmentId: "00000000-0000-4000-8000-000000000011", name: "page-1440.webm", kind: "clip", mime: "video/webm", bytes: 10, url: "/api/attachments/00000000-0000-4000-8000-000000000011/download" },
          phone: { attachmentId: "00000000-0000-4000-8000-000000000012", name: "page-390.png", kind: "picture", mime: "image/png", bytes: 10, url: "/api/attachments/00000000-0000-4000-8000-000000000012/download" },
          still: { attachmentId: "00000000-0000-4000-8000-000000000013", name: "page-still.png", kind: "picture", mime: "image/png", bytes: 10, url: "/api/attachments/00000000-0000-4000-8000-000000000013/download" },
          seconds: 20,
          verdictId: "00000000-0000-4000-8000-000000000014",
          criterion: 1,
        },
      },
    ],
    fixes: [{ issueKey: "ISS-2", kind: "fixed", section: "Fixed", line: "Dates show correctly.", detail: null, requirementKey: null, visual: null, ui: false }],
    visualsOwed: null,
    card: null,
    internal: { count: 1, changes: null },
    withoutNotes: [{ issueKey: "ISS-9", title: "Rename a helper", why: "no_note" }],
    actionRequired: [
      { kind: "step", sentence: "Start a worker on the release-highlights queue.", ref: null, issues: ["ISS-1"] },
      { kind: "migration", sentence: "Back up the database before this release deploys: it changes the schema.", ref: "0478_release_highlights.sql", issues: ["ISS-1"] },
    ],
    shipped: { state: "read", base: "b".repeat(40), head: BUILD, migrations: ["packages/core/drizzle/migrations/0478_release_highlights.sql"], contracts: [], dependencies: [], settings: [], unchecked: [] },
    knownIssues: [
      { issueKey: "ISS-3", requirementKey: "REQ-40", bc: "BC-8", statement: "Known issues are listed.", standing: "short", reason: "the list is empty on mobile", elsewhere: null },
      { issueKey: "ISS-4", requirementKey: "REQ-40", bc: "BC-9", statement: "A developer view adds notes.", standing: "not_judged", reason: null, elsewhere: { verdict: "pass", commitSha: "b".repeat(40) } },
    ],
    technical: null,
    stalls: { counts: { unclear_item: 0, defect: 0, waiting_on_person: 0 }, stalls: [] },
    can: { share: true, export: true, approve: false },
    ...over,
  };
}

/** A summary as the naming door asks for one, in two or three sentences: forge-dev's run 45 to 62 words (ISS-1368). */
export const SERVED_SUMMARY =
  "Every secret a project needs now lives on one Settings page, where an assistant's request says why it is needed and what shape it takes. A person fills it with a form fitted to that shape or a one-time terminal command, and the assistant gets a receipt. Assistants also confirm a missing capability before asking the project that builds it.";

type Change = ReleasePage["improvements"][number];

const served = (issueKey: string, kind: Change["kind"], line: string, detail: string, over: Partial<Change> = {}): Change => ({
  issueKey,
  kind,
  section: kind === "fixed" ? "Fixed" : kind === "new" ? "Added" : "Changed",
  line,
  detail,
  requirementKey: null,
  visual: null,
  ui: true,
  ...over,
});

/**
 * A release page shaped as forge-dev serves 0.4.0-dev.752 (ISS-1368): its name and a 60-word summary,
 * three What's new rows (one on a named screen), one Fixed row whose landing touched no screen, no
 * clip, and 5 of 17 criteria proven, so Needs attention says the 12 still owed.
 */
export function servedReleasePage(over: Partial<ReleasePage> = {}): ReleasePage {
  const page = releasePage();
  return {
    ...page,
    header: { ...page.header, name: "One Secrets page for every secret", summary: SERVED_SUMMARY, verified: { ...page.header.verified, proven: 5, total: 17 } },
    requirements: [],
    improvements: [
      served("ISS-1", "new", "One Secrets page where people give every secret", "Every secret a project needs now lives on one Settings page, filled with a form fitted to its shape."),
      served("ISS-2", "improved", "Agents confirm a missing capability before requesting it", "An assistant that meets a missing command first confirms the need, then asks the project that builds it.", { screen: "Execution" }),
      served("ISS-3", "improved", "Direct-mode masters declare builder runs with the right role", "A master building directly declares each builder's run before its build."),
    ],
    fixes: [served("ISS-4", "fixed", "A shared room's secret link reaches the right project", "A secret asked for in a shared room names the project it is for.", { ui: false })],
    internal: { count: 0, changes: null },
    withoutNotes: [],
    actionRequired: [],
    shipped: { state: "read", base: "b".repeat(40), head: BUILD, migrations: [], contracts: [], dependencies: [], settings: [], unchecked: [] },
    knownIssues: [],
    ...over,
  };
}

export const TECHNICAL: NonNullable<ReleasePage["technical"]> = {
  notes: [{ issueKey: "ISS-1", title: "Release page", technical: "Reads release-read through sections.ts." }],
  migrations: ["0478_release_highlights.sql"],
  contracts: ["packages/contracts/src/release-page.ts"],
  dependencies: ["no new dependency"],
  settings: ["PREVIEW_DOMAIN (optional)"],
  changes: { surfaces: [], risks: [], unclassified: [], boxRead: [], shipsNothing: false },
};
