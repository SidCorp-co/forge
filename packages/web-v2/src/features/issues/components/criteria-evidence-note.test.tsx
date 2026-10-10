// REQ-40 BC-4 (QA 0.4.0-dev.218): the issue's Criteria tab showed a verdict's badge and nothing of
// what the judge wrote or kept. The row now carries the verdict's own evidence note and the clip it
// names, played from the issue's attachment.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueDetail } from "../types";
import { IssueCriteria } from "./issue-criteria";

const ATTACHMENT = "00000000-0000-4000-8000-0000000000bb";

const row = {
  id: "c1",
  n: 1,
  statement: "Each release has a page.",
  position: 0,
  requirementCriterionId: "bc-1",
  latest: {
    verdict: "pass",
    reason: "Opened 0.4.0 and read its version, date and approver; the clip shows it.",
    identityKind: "commit",
    commitSha: "a".repeat(40),
    runtimeRef: null,
    designFlow: null,
    designWorkflowId: null,
    designRevision: null,
    contractRef: null,
    contractVersion: null,
    storefrontWorkflowId: null,
    storefrontDraftVersion: null,
    storefrontEnvironment: null,
    corroboration: null,
    corroborationNote: null,
    evidence: ["iss492-bc1-release-header.webm", "not-attached.txt"],
    authorAgency: "agent",
    backfilled: false,
    createdAt: "2026-10-09T10:00:00Z",
  },
};

const issue = { id: "i1", projectId: "p1", status: "developed", mergedCommitSha: null, liveReach: null } as unknown as IssueDetail;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a criterion's verdict on the issue Criteria tab", () => {
  it("shows the verdict's own note and plays the clip its evidence names", async () => {
    fakeCore((c) => {
      if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [row], retired: [] } };
      if (c.method === "GET" && c.path === "/issues/i1/attachments")
        return {
          body: [
            { id: ATTACHMENT, issueId: "i1", uploaderId: null, name: "iss492-bc1-release-header.webm", mime: "video/webm", size: 10, url: `/api/attachments/${ATTACHMENT}/download`, createdAt: "2026-10-09T10:00:00Z" },
          ],
        };
      return undefined;
    });
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:clip-${++n}`);
    URL.revokeObjectURL = vi.fn();
    // the clip's bytes come from the download address; everything else is the fake core's
    const core = globalThis.fetch;
    const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith("/download") ? new Response("webm", { headers: { "content-type": "video/webm" } }) : core(input, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithQuery(<IssueCriteria issue={issue} projectId="p1" checklist={[]} canWrite={false} requirementKey="REQ-40" />);
    // the row is one line; its evidence is on the open row
    await userEvent.click((await screen.findByTestId("criterion-1-verdict")).closest("button") as HTMLElement);
    const evidence = await screen.findByTestId("verdict-evidence");
    expect(within(evidence).getByTestId("verdict-note")).toHaveTextContent("Opened 0.4.0 and read its version, date and approver");
    // only the file the issue keeps is reachable; a name it keeps nothing under is not a link to nothing
    expect(within(evidence).getAllByTestId("verdict-file")).toHaveLength(1);
    await userEvent.click(within(evidence).getByRole("button", { name: /Watch the clip: iss492-bc1-release-header.webm/ }));
    const video = await within(evidence).findByTestId("verdict-clip");
    expect(video).toHaveAttribute("src", "blob:clip-1");
    expect(fetchMock.mock.calls.some((c) => urlOf(c[0]).endsWith(`/api/attachments/${ATTACHMENT}/download`))).toBe(true);
  });

  it("draws no evidence block under a verdict that wrote no note and kept no file", async () => {
    fakeCore((c) =>
      c.method === "GET" && c.path === "/issues/i1/criteria"
        ? { body: { criteria: [{ ...row, latest: { ...row.latest, reason: null, evidence: [] } }], retired: [] } }
        : c.method === "GET" && c.path === "/issues/i1/attachments"
          ? { body: [] }
          : undefined,
    );
    renderWithQuery(<IssueCriteria issue={issue} projectId="p1" checklist={[]} canWrite={false} requirementKey="REQ-40" />);
    await userEvent.click((await screen.findByTestId("criterion-1-verdict")).closest("button") as HTMLElement);
    expect(await screen.findAllByText("Each release has a page.")).not.toHaveLength(0);
    expect(screen.queryByTestId("verdict-evidence")).toBeNull();
  });
});
