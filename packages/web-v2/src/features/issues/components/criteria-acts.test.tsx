// The live QA of ISS-419..429 (2026-10-08) could record no verdict and tie no issue to its
// requirement's criteria from the web: the Criteria tab was read-only, so criterion_verdicts stayed
// empty on shipped work. A person records a verdict from the row (judged at the build core names by
// default, a note as its reason, a screenshot attached and cited), and ties a closed issue to the
// business criteria it delivered.
//
// The live QA of dev.192/193 (REQ-6 BC-2..BC-4) then found the Judge offered no "could not judge"
// (twelve such verdicts went in as Short and counted as passing), never pre-filled the live build on
// an issue whose merge names no commit, and dead-ended on a screenshot whose name was already
// attached.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import type { IssueDetail } from "../types";
import { CriteriaTab } from "./detail/issue-tabs";

const LIVE = "0d91ae7c74f70295ede115463b17559e650b5207";
const SHIPPED = "33637c612ef15be6f924520c0d201a0889d8ed7e";

const criterion = (n: number, latest: unknown = null) => ({
  id: `c${n}`,
  n,
  statement: `(REQ-32 BC-${n}) The report names its source`,
  position: n - 1,
  requirementCriterionId: `w${n}`,
  latest,
});

// the shape of ISS-432 on dev.192: merged with no commit named, no promotion to read a reach from
const issue = (over: Partial<IssueDetail> = {}) =>
  ({
    id: "i1",
    projectId: "p1",
    status: "closed",
    mergedCommitSha: null,
    liveReach: null,
    ...over,
  }) as IssueDetail;

const LIVE_BUILD = { sha: LIVE, source: "live", version: "0.4.0-dev.192", basis: "production serves release 0.4.0-dev.192, which shipped this issue" };

const ATTACHED = [{ id: "a1", issueId: "i1", uploaderId: "u1", name: "report-1440.png", mime: "image/png", size: 3, url: "/api/attachments/a1/download", createdAt: "2026-10-08T00:00:00Z" }];

function core(
  extra: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined,
  build: unknown = LIVE_BUILD,
  attached: unknown[] = [],
) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [criterion(1), criterion(2)] } };
    if (c.method === "GET" && c.path === "/issues/i1/judged-build") return { body: build };
    if (c.method === "GET" && c.path === "/issues/i1/attachments") return { body: attached };
    return extra(c);
  });
}

async function openJudge(n: number) {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId(`criterion-${n}-judge`));
  return { user, form: await screen.findByTestId("verdict-form") };
}

const verdictPosted = (calls: Call[]) => calls.find((c) => c.method === "POST" && c.path === "/issues/i1/verdicts")?.body;

describe("the build a verdict is judged at, by default", () => {
  it("is the live build core names, on an issue whose merge names no commit", async () => {
    core();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { form } = await openJudge(1);
    expect(await within(form).findByDisplayValue(LIVE)).toBeInTheDocument();
    expect(form).toHaveTextContent("The commit the live deployment runs (0.4.0-dev.192)");
  });

  it("is the build that shipped the work where core cannot show the live one carries it, and says why", async () => {
    core(undefined, { sha: SHIPPED, source: "shipped", version: "0.4.0-dev.191", basis: "release 0.4.0-dev.191 shipped this issue's work at this commit; whether production holds it could not be read" });
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { form } = await openJudge(1);
    expect(await within(form).findByDisplayValue(SHIPPED)).toBeInTheDocument();
    expect(form).toHaveTextContent("could not be read");
  });
});

describe("recording a verdict from a criterion row", () => {
  it("sends pass at the deployed commit with the note as its reason, on a closed issue", async () => {
    const calls = core((c) => (c.method === "POST" && c.path === "/issues/i1/verdicts" ? { status: 201, body: { verdictId: "v1" } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    expect(await within(form).findByDisplayValue(LIVE)).toBeInTheDocument();
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
      if (c.method === "POST" && c.path === "/issues/i1/attachments") return { status: 201, body: { id: "a1", name: "report-1440.png" } };
      if (c.method === "POST" && c.path === "/issues/i1/verdicts") return { status: 201, body: { verdictId: "v1" } };
      return undefined;
    });
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(2);
    await user.click(within(form).getByRole("button", { name: "Fail" }));
    await user.upload(within(form).getByTestId("verdict-screenshot"), new File(["png"], "report-1440.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/issues/i1/attachments", "/issues/i1/verdicts"]));
    const upload = calls.find((c) => c.method === "POST" && c.path === "/issues/i1/attachments")?.body as FormData;
    expect((upload.get("file") as File).name).toBe("report-1440.png");
    expect(calls.find((c) => c.path === "/issues/i1/verdicts")?.body).toMatchObject({ criterion: 2, verdict: "fail", evidence: ["report-1440.png"], reason: null });
  });

  it("holds the verdict back until a whole sha is named, where core names no build", async () => {
    const calls = core(undefined, { sha: null, source: null, version: null, basis: "this issue has not merged, so no build carries its work yet" });
    renderWithQuery(<CriteriaTab issue={issue({ status: "in_progress" })} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey={null} />);
    const { user, form } = await openJudge(1);
    const send = screen.getByRole("button", { name: "Record verdict" });
    expect(await within(form).findByText(/this issue has not merged/)).toBeInTheDocument();
    expect(send).toBeDisabled();
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

  it("records could not judge as skipped, never as a pass, and only with a reason", async () => {
    const calls = core((c) => (c.method === "POST" && c.path === "/issues/i1/verdicts" ? { status: 201, body: { verdictId: "v1" } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    await within(form).findByDisplayValue(LIVE);
    await user.click(within(form).getByRole("button", { name: "Could not judge" }));
    const send = screen.getByRole("button", { name: "Record verdict" });
    expect(send).toBeDisabled();
    expect(form).toHaveTextContent("never counts as a pass");
    await user.type(within(form).getByRole("textbox", { name: /Why it could not be judged/ }), "The property is in the code, not on any screen.");
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() =>
      expect(verdictPosted(calls)).toEqual({
        criterion: 1,
        verdict: "skipped",
        reason: "The property is in the code, not on any screen.",
        identity: { kind: "commit", sha: LIVE },
        evidence: [],
      }),
    );
  });

  it("records could not judge with no build named, where none could be", async () => {
    const calls = core(
      (c) => (c.method === "POST" && c.path === "/issues/i1/verdicts" ? { status: 201, body: { verdictId: "v1" } } : undefined),
      { sha: null, source: null, version: null, basis: "this issue has not merged, so no build carries its work yet" },
    );
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    await within(form).findByText(/this issue has not merged/);
    await user.click(within(form).getByRole("button", { name: "Could not judge" }));
    await user.type(within(form).getByRole("textbox", { name: /Why it could not be judged/ }), "Nothing deployed carries it.");
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(verdictPosted(calls)).toMatchObject({ verdict: "skipped", identity: null }));
  });

  it("says plainly that Short counts as a pass", async () => {
    core();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { form } = await openJudge(1);
    expect(within(form).getByRole("button", { name: "Pass, short of wording" })).toBeInTheDocument();
    expect(form).toHaveTextContent("Short counts as a pass");
  });

  it("cites an attachment the issue already holds, uploading nothing", async () => {
    const calls = core((c) => (c.method === "POST" && c.path === "/issues/i1/verdicts" ? { status: 201, body: { verdictId: "v1" } } : undefined), LIVE_BUILD, ATTACHED);
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    await within(form).findByDisplayValue(LIVE);
    await user.selectOptions(await within(form).findByRole("combobox", { name: "Attached to this issue" }), "report-1440.png");
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(verdictPosted(calls)).toMatchObject({ verdict: "pass", evidence: ["report-1440.png"] }));
    expect(calls.some((c) => c.method === "POST" && c.path === "/issues/i1/attachments")).toBe(false);
  });

  it("uploads a screenshot whose name is already attached under a free name it shows first", async () => {
    const calls = core(
      (c) => {
        if (c.method === "POST" && c.path === "/issues/i1/attachments") return { status: 201, body: { id: "a2", name: "report-1440-2.png" } };
        if (c.method === "POST" && c.path === "/issues/i1/verdicts") return { status: 201, body: { verdictId: "v1" } };
        return undefined;
      },
      LIVE_BUILD,
      ATTACHED,
    );
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    await within(form).findByRole("combobox", { name: "Attached to this issue" });
    await user.upload(within(form).getByTestId("verdict-screenshot"), new File(["png"], "report-1440.png", { type: "image/png" }));
    expect(form).toHaveTextContent("report-1440.png is already attached to this issue; this one uploads as report-1440-2.png");
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(verdictPosted(calls)).toMatchObject({ evidence: ["report-1440-2.png"] }));
    const upload = calls.find((c) => c.path === "/issues/i1/attachments" && c.method === "POST")?.body as FormData;
    expect((upload.get("file") as File).name).toBe("report-1440-2.png");
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

describe("recording a clip as a verdict's evidence (REQ-40 BC-4)", () => {
  it("attaches a clip the way a screenshot is, and cites it by the name core kept (REQ-40 BC-4)", async () => {
    const calls = core((c) => {
      if (c.method === "POST" && c.path === "/issues/i1/attachments") return { status: 201, body: { id: "a2", name: "bc-1.webm" } };
      if (c.method === "POST" && c.path === "/issues/i1/verdicts") return { status: 201, body: { verdictId: "v1" } };
      return undefined;
    });
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    const input = within(form).getByTestId("verdict-screenshot") as HTMLInputElement;
    expect(input.accept).toContain("video/webm");
    expect(input.accept).toContain("video/mp4");
    await user.upload(input, new File([new Uint8Array(2048)], "bc-1.webm", { type: "video/webm" }));
    expect(await within(form).findByTestId("verdict-clip-chosen")).toHaveTextContent("bc-1.webm");
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/issues/i1/attachments", "/issues/i1/verdicts"]));
    const upload = calls.find((c) => c.method === "POST" && c.path === "/issues/i1/attachments")?.body as FormData;
    expect((upload.get("file") as File).type).toBe("video/webm");
    expect(calls.find((c) => c.path === "/issues/i1/verdicts")?.body).toMatchObject({ criterion: 1, verdict: "pass", evidence: ["bc-1.webm"] });
  });

  it("refuses a clip over the cap before any upload, naming the cap, and sends nothing", async () => {
    const calls = core();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { user, form } = await openJudge(1);
    // userEvent.upload applies `accept`, so the oversize case is dropped past it, as a drag would
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "long-tour.webm", { type: "video/webm" });
    await user.upload(within(form).getByTestId("verdict-screenshot"), big);
    expect(await within(form).findByTestId("verdict-evidence-refusal")).toHaveTextContent("long-tour.webm is over the 10 MB cap for a clip");
    expect(within(form).queryByTestId("verdict-clip-chosen")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Record verdict" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/issues/i1/verdicts")).toBe(true));
    expect(calls.some((c) => c.method === "POST" && c.path === "/issues/i1/attachments")).toBe(false);
    expect(calls.find((c) => c.path === "/issues/i1/verdicts")?.body).toMatchObject({ evidence: [] });
  });

  it("refuses a file that is neither a clip nor a picture, naming what is valid", async () => {
    core();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows checklist={[]} canWrite requirementKey="REQ-32" />);
    const { form } = await openJudge(1);
    // a drag past `accept`, which userEvent.upload would filter out
    fireEvent.change(within(form).getByTestId("verdict-screenshot"), { target: { files: [new File(["x"], "run.log", { type: "text/plain" })] } });
    expect(await within(form).findByTestId("verdict-evidence-refusal")).toHaveTextContent("run.log is not a picture or a webm or mp4 clip");
  });
});

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

  // coverage-truth: ISS-412's BC-13 trace sat on r1 after r6 reworded it; the dialog matched by code
  // and showed it "already tied", so the current wording could never be tied on the issue delivering it
  it("offers a BC tied only at an earlier wording, saying a tie refreshes it, and sends it", async () => {
    const reworded = [{ code: "BC-13", body: "A new report or share destination is a port", verdict: "stale", issues: [{ issueId: "i1", stale: true }], uncoveredReason: null }];
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === "/issues/i1/criteria") return { body: { criteria: [] } };
      if (c.method === "GET" && c.path === "/projects/p1/requirements/REQ-32") return { body: { standing: { coverage: reworded } } };
      if (c.method === "POST" && c.path === "/issues/i1/criteria/traces") return { status: 201, body: { criteria: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<CriteriaTab issue={issue()} projectId="p1" hasCriteriaRows={false} checklist={[]} canWrite requirementKey="REQ-32" />);
    await user.click(screen.getByRole("button", { name: "Tie to REQ-32 criteria" }));
    const form = await screen.findByTestId("tie-form");
    const box = await within(form).findByRole("checkbox", { name: /BC-13 .* · tied to an earlier wording; tying refreshes it to this one/ });
    expect(box).not.toBeChecked();
    expect(box).not.toHaveAttribute("data-disabled");
    expect(form).not.toHaveTextContent("already tied");
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Tie 1" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/issues/i1/criteria/traces", body: { codes: ["BC-13"] } }));
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
