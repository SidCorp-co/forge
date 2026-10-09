import type { ReleasePage } from "@forge/contracts/release-page";

export const BUILD = "a".repeat(40);

/** A release page as core serves it for a shipped release: every user section filled, one clip, one known issue. */
export function releasePage(over: Partial<ReleasePage> = {}): ReleasePage {
  return {
    view: "user",
    projectId: "p1",
    header: {
      version: "0.4.0",
      state: "shipped",
      releasedAt: "2026-10-09T10:00:00.000Z",
      environment: { name: "production", url: "https://forge.example" },
      build: BUILD,
      verified: { level: "criteria", proven: 2, total: 3, check: null, provider: null },
      approval: { required: true, state: "approved", by: { id: "u1", name: "Ada", kind: "human" }, at: "2026-10-09T09:00:00.000Z" },
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
          mediaGap: null,
        },
      ],
    },
    requirements: [
      { key: "REQ-40", title: "Release page", completes: true, proven: [{ code: "BC-1", statement: "Each release has a page." }], unproven: 1 },
    ],
    improvements: [{ issueKey: "ISS-1", kind: "new", line: "Releases read as pages." }],
    fixes: [{ issueKey: "ISS-2", kind: "fixed", line: "Dates show correctly." }],
    withoutNotes: [{ issueKey: "ISS-9", title: "Rename a helper", why: "no_note" }],
    actionRequired: [{ kind: "migration", sentence: "Run the database migration before opening the app.", ref: "0478_release_highlights.sql", issues: ["ISS-1"] }],
    knownIssues: [
      { issueKey: "ISS-3", requirementKey: "REQ-40", bc: "BC-8", statement: "Known issues are listed.", standing: "short", reason: "the list is empty on mobile", elsewhere: null },
      { issueKey: "ISS-4", requirementKey: "REQ-40", bc: "BC-9", statement: "A developer view adds notes.", standing: "not_judged", reason: null, elsewhere: { verdict: "pass", commitSha: "b".repeat(40) } },
    ],
    technical: null,
    can: { share: true, export: true, approve: false },
    ...over,
  };
}

export const TECHNICAL: NonNullable<ReleasePage["technical"]> = {
  notes: [{ issueKey: "ISS-1", title: "Release page", technical: "Reads release-read through sections.ts." }],
  migrations: ["0478_release_highlights.sql"],
  contracts: ["packages/contracts/src/release-page.ts"],
  dependencies: ["no new dependency"],
  changes: { surfaces: [], risks: [], unclassified: [], boxRead: [], shipsNothing: false },
};
