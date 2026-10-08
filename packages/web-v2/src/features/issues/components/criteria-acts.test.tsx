// The live QA of ISS-419..429 (2026-10-08) could record no verdict and tie no issue to its
// requirement's criteria from the web: the Criteria tab was read-only, so criterion_verdicts stayed
// empty on shipped work. A person records a verdict from the row (judged at the deployed commit by
// default, a note as its reason, a screenshot attached and cited), and ties a closed issue to the
// business criteria it delivered.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { defaultVerdictCommit } from "../criteria";
import type { IssueDetail } from "../types";
import { CriteriaTab } from "./detail/issue-tabs";

const LIVE = "0d91ae7c74f70295ede115463b17559e650b5207";
const MERGED = "33637c612ef15be6f924520c0d201a0889d8ed7e";

const criterion = (n: number, latest: unknown = null) => ({
  id: `c${n}`,
  n,
  statement: `(REQ-32 BC-${n}) The report names its source`,
  position: n - 1,
  requirementCriterionId: `w${n}`,
  latest,
});

const issue = (over: Partial<IssueDetail> = {}) =>
  ({
    id: "i1",
    projectId: "p1",
    status: "closed",
    mergedCommitSha: MERGED,
    liveReach: { state: "none_waiting", baseBranch: "dev", deploysFrom: "dev", measuredAt: "2026-10-08T00:00:00Z", baseSha: MERGED, liveSha: LIVE, unowned: [] },
    ...over,
  }) as IssueDetail;

function core(extra: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [criterion(1), criterion(2)] } };
    return extra(c);
  });
}

async function openJudge(n: number) {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId(`criterion-${n}-judge`));
  return { user, form: await screen.findByTestId("verdict-form") };
}

describe("the commit a verdict is judged at, by default", () => {
  it("is the live deployment's commit when core reads the issue's work on it", () => {
    expect(defaultVerdictCommit(issue())).toEqual({ sha: LIVE, source: "live" });
  });

  it("is the merge commit while the work is not on the live deployment", () => {
    const notLive = issue({ liveReach: { state: "not_on_live", baseBranch: "dev", deploysFrom: "dev", measuredAt: "x", baseSha: MERGED, liveSha: LIVE, evidence: [] } });
    expect(defaultVerdictCommit(notLive)).toEqual({ sha: MERGED, source: "merged" });
  });

  it("is none where the issue names neither, or only an abbreviation", () => {
    expect(defaultVerdictCommit(issue({ liveReach: null, mergedCommitSha: null }))).toBeNull();
    expect(defaultVerdictCommit(issue({ liveReach: null, mergedCommitSha: "33637c6" }))).toBeNull();
  });
});

describe("recording a verdict from a criterion row", () => {
  it("sends pass at the deployed commit with the note as its reason, on a closed issue", async () => {
    const calls = core((c) => (c.method === "POST" && c.path === "/issues/i1/verdicts" ? { status: 201, body: { verdictId: "v1" } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    expect(within(form).getByDisplayValue(LIVE)).toBeInTheDocument();
    expect(form).toHaveTextContent("The commit the live deployment runs");
    await user.type(within(form).getByRole("textbox", { name: "Evidence note" }), "Opened the weekly report; the source line names run r-7.");
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/issues/i1/verdicts",
        body: {
          criterion: 1,
          verdict: "pass",
          reason: "Opened the weekly report; the source line names run r-7.",
          identity: { kind: "commit", sha: LIVE },
          evidence: [],
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("verdict-form")).toBeNull());
  });

  it("attaches the screenshot to the issue first and cites it by the name core kept", async () => {
    const calls = core((c) => {
      if (c.method === "POST" && c.path === "/issues/i1/attachments") return { status: 201, body: { id: "a1", name: "report-1440 (1).png" } };
      if (c.method === "POST" && c.path === "/issues/i1/verdicts") return { status: 201, body: { verdictId: "v1" } };
      return undefined;
    });
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(2);
    await user.click(within(form).getByRole("button", { name: "Fail" }));
    await user.upload(within(form).getByTestId("verdict-screenshot"), new File(["png"], "report-1440.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/issues/i1/attachments", "/issues/i1/verdicts"]));
    const upload = calls.find((c) => c.path === "/issues/i1/attachments")?.body as FormData;
    expect((upload.get("file") as File).name).toBe("report-1440.png");
    expect(calls.find((c) => c.path === "/issues/i1/verdicts")?.body).toMatchObject({ criterion: 2, verdict: "fail", evidence: ["report-1440 (1).png"], reason: null });
  });

  it("holds the verdict back until a whole sha is named, where the issue names no commit", async () => {
    const calls = core();
    renderWithQuery(<CriteriaTab issue={issue({ liveReach: null, mergedCommitSha: null })} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey={null} />);
    const { user, form } = await openJudge(1);
    const send = screen.getByRole("button", { name: "Record verdict" });
    expect(send).toBeDisabled();
    expect(form).toHaveTextContent("names no deployed or merged commit");
    const sha = within(form).getByRole("textbox", { name: "Judged at commit" });
    await user.type(sha, "0d91ae7");
    expect(send).toBeDisabled();
    expect(form).toHaveTextContent("A whole 40-character commit sha.");
    await user.clear(sha);
    await user.type(sha, LIVE);
    expect(send).toBeEnabled();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("shows core's refusal by name and keeps the form open", async () => {
    core((c) =>
      c.method === "POST"
        ? { status: 422, body: { error: { code: "VERDICT_COMMIT_NOT_FULL", message: "refused", refusals: [{ code: "VERDICT_COMMIT_NOT_FULL", path: "", detail: "criterion 1 names commit `x`, and a verdict names the whole 40-character sha" }] } } }
        : undefined,
    );
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    expect(await within(form).findByTestId("verdict-refusal")).toHaveTextContent("VERDICT_COMMIT_NOT_FULL");
    expect(screen.getByTestId("verdict-form")).toBeInTheDocument();
  });

  it("offers no verdict act to a reader who may not write", async () => {
    core();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite={false} requirementKey="REQ-32" />);
    expect(await screen.findByTestId("criterion-1-verdict")).toBeInTheDocument();
    expect(screen.queryByTestId("criterion-1-judge")).toBeNull();
    expect(screen.queryByTestId("criteria-tie")).toBeNull();
  });
});

const coverage = [
  { code: "BC-1", body: "The report names its source", verdict: "pass", issues: [{ issueId: "i1" }], uncoveredReason: null },
  { code: "BC-7", body: "A template run can be saved", verdict: "gap", issues: [], uncoveredReason: null },
  { code: "BC-8", body: "A template can be scheduled", verdict: "gap", issues: [{ issueId: "other" }], uncoveredReason: null },
];

describe("tying a closed issue to its requirement's criteria", () => {
  it("lists the BCs, keeps the ones already tied fixed, and sends the codes picked", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [] } };
      if (c.method === "GET" && c.path === "/projects/p1/requirements/REQ-32") return { body: { standing: { coverage } } };
      if (c.method === "POST" && c.path === "/issues/i1/criteria/traces") return { status: 201, body: { criteria: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows={false} checklist={[]} canWrite requirementKey="REQ-32" />);
    expect(screen.getByTestId("view-criteria")).toHaveTextContent("Tie this issue to its requirement's criteria");
    await user.click(screen.getByRole("button", { name: "Tie to REQ-32 criteria" }));
    const form = await screen.findByTestId("tie-form");
    const held = await within(form).findByRole("checkbox", { name: /BC-1 The report names its source · already tied/ });
    expect(held).toBeChecked();
    expect(held).toHaveAttribute("data-disabled");
    expect(screen.getByRole("button", { name: "Tie 0" })).toBeDisabled();
    await user.click(within(form).getByRole("checkbox", { name: /BC-7/ }));
    await user.click(within(form).getByRole("checkbox", { name: /BC-8/ }));
    await user.click(screen.getByRole("button", { name: "Tie 2" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/issues/i1/criteria/traces", body: { codes: ["BC-7", "BC-8"] } }));
    await waitFor(() => expect(screen.queryByTestId("tie-form")).toBeNull());
  });

  it("shows core's refusal by name", async () => {
    fakeCore((c) => {
      if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [] } };
      if (c.method === "GET" && c.path === "/projects/p1/requirements/REQ-32") return { body: { standing: { coverage } } };
      return {
        status: 422,
        body: { error: { code: "CRITERIA_TRACE_UNRESOLVED", message: "refused", refusals: [{ code: "CRITERIA_TRACE_UNRESOLVED", path: "/codes", detail: "REQ-32 has no wording of BC-7 live at revision 1" }] } },
      };
    });
    const user = userEvent.setup();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows={false} checklist={[]} canWrite requirementKey="REQ-32" />);
    await user.click(screen.getByRole("button", { name: "Tie to REQ-32 criteria" }));
    const form = await screen.findByTestId("tie-form");
    await user.click(await within(form).findByRole("checkbox", { name: /BC-7/ }));
    await user.click(screen.getByRole("button", { name: "Tie 1" }));
    expect(await within(form).findByTestId("tie-refusal")).toHaveTextContent("no wording of BC-7 live at revision 1");
  });

  it("offers no tie where the issue delivers no requirement", async () => {
    fakeCore((c) => (c.path === "/issues/i1/criteria" ? { body: { criteria: [] } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows={false} checklist={[]} canWrite requirementKey={null} />);
    expect(screen.getByTestId("view-criteria")).toHaveTextContent("No criteria yet; the plan step writes them.");
    expect(screen.queryByTestId("criteria-tie")).toBeNull();
  });
});
