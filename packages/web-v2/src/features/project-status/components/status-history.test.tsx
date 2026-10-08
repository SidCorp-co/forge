// A kept status report could not be removed from the page (journey walk 2026-10-08, F17), and the
// schedule's Delete removed it at one press. The person who saved a report, or a project admin,
// removes it after a confirmation; nobody else is offered the act, and core's refusal reads in the
// dialog when it comes anyway.

import type { ReportDocument } from "@forge/contracts/report-templates";
import type { StatusReportMeta } from "@forge/contracts/status-reports";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { StatusHistory } from "./status-history";
import { templateReportFile } from "./template-report";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: ME } }) }));

const clock = { lang: "en" as const, now: Date.parse("2026-10-08T10:00:00Z"), timeZone: "UTC" };

const report = (id: string, by: string | null, kind: "person" | "schedule" = "person"): StatusReportMeta => ({
  id,
  projectId: "p1",
  asOf: "2026-10-08T09:00:00.000Z",
  days: 7,
  template: null,
  period: kind === "schedule" ? "2026-10-06T02:00:00.000Z" : null,
  producer: {
    kind,
    user: by ? { id: by, name: by === ME ? "Me" : "Minh" } : null,
    schedule: kind === "schedule" ? { id: "s1", name: "Weekly status" } : null,
  },
});

const MINE = report("r-mine", ME);
const THEIRS = report("r-theirs", OTHER);
const SENT = report("r-sent", ME, "schedule");

function core(reports: StatusReportMeta[], onDelete: (call: Call) => { status?: number; body: unknown } = (c) => ({ body: { deleted: c.path.split("/").pop() } })) {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === "/projects/p1/status/reports") return { body: { reports } };
    if (call.method === "GET" && call.path.startsWith("/schedules?")) return { body: [] };
    if (call.method === "DELETE") return onDelete(call);
    return undefined;
  });
}

const rows = () => screen.findAllByTestId("status-history-row");
const removeButtons = () => screen.queryAllByTestId("status-history-remove");

describe("removing a kept status report", () => {
  it("offers Remove only on the report the reader saved, when they are not an admin", async () => {
    core([MINE, THEIRS, SENT]);
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin={false} />);
    expect(await rows()).toHaveLength(3);
    const offered = removeButtons().map((b) => b.closest("li")?.textContent);
    expect(offered).toEqual([expect.stringContaining("Saved by Me")]);
  });

  it("offers Remove on every report to a project admin", async () => {
    core([MINE, THEIRS, SENT]);
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin />);
    expect(await rows()).toHaveLength(3);
    expect(removeButtons()).toHaveLength(3);
  });

  it("removes nothing until the reader confirms, then removes that one report", async () => {
    const calls = core([MINE]);
    const user = userEvent.setup();
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin={false} />);
    await rows();
    await user.click(removeButtons()[0] as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove this kept report?");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Remove report" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: "/projects/p1/status/reports/r-mine", body: undefined }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("shows core's refusal in the dialog and keeps the report", async () => {
    core([MINE], () => ({
      status: 403,
      body: { code: "STATUS_REPORT_DELETE_FORBIDDEN", message: "status report r-mine is removed only by the person who saved it or a project admin", detail: "status report r-mine is removed only by the person who saved it or a project admin" },
    }));
    const user = userEvent.setup();
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin={false} />);
    await rows();
    await user.click(removeButtons()[0] as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The report was not removed");
    expect(screen.getAllByTestId("status-history-row")).toHaveLength(1);
  });
});

describe("a kept template report", () => {
  const frame = {
    fields: [
      { name: "requirement", type: "ref" as const, label: "Requirement" },
      { name: "proven", type: "number" as const, label: "Proven" },
    ],
    rows: [{ requirement: "REQ-7", proven: 5 }],
  };
  const document: ReportDocument = {
    templateId: "progress",
    version: 1,
    params: {},
    runs: [
      {
        runId: "run-1",
        queryId: "progress-by-requirement",
        version: 1,
        params: {},
        projectId: "p1",
        actor: { kind: "human", id: ME },
        asOf: "2026-10-08T09:00:00.000Z",
        frame,
      },
    ],
    blocks: [{ kind: "table", v: 1, title: "Progress", columns: ["requirement", "proven"], source: { runId: "run-1" }, frame }],
    narrative: { summary: "One requirement moved.", risks: "", recommendations: "" },
  };
  const TEMPLATE: StatusReportMeta = { ...report("r-template", ME), days: null, template: { id: "progress", version: 1, title: "Progress" } };

  function open(calls: Call[] = []) {
    const log = fakeCore((call) => {
      calls.push(call);
      if (call.method === "GET" && call.path === "/projects/p1/status/reports") return { body: { reports: [TEMPLATE, MINE] } };
      if (call.method === "GET" && call.path === "/projects/p1/status/reports/r-template")
        return { body: { report: TEMPLATE, status: null, document, previous: null, diff: null } };
      if (call.method === "POST" && call.path === "/projects/p1/status/reports/r-template/read") return { body: { read: 0 } };
      if (call.method === "GET" && call.path === "/projects/p1/shares/audiences")
        return { body: { audiences: [{ audience: "members", refusal: null }, { audience: "link", refusal: { code: "PERMISSION_FORBIDDEN", message: "needs shares.public" } }] } };
      if (call.method === "POST" && call.path === "/projects/p1/shares")
        return { status: 201, body: { share: { id: "s1", audience: "members", expiresAt: "2026-10-15T09:00:00.000Z", title: "Progress" }, url: "https://forge.test/s/forge_share_abc" } };
      if (call.path.startsWith("/schedules?")) return { body: [] };
      return undefined;
    });
    return log;
  }

  it("lists it beside the project status reads, named by its template instead of a window", async () => {
    open();
    window.history.replaceState({}, "", "/?report=r-template");
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin={false} />);
    const listed = await rows();
    expect(listed.map((r) => r.textContent)).toEqual([expect.stringContaining("Progress"), expect.stringContaining("the last 7 days")]);
  });

  it("opens it with its kept narrative, names the slots nobody wrote, and shares it with the members", async () => {
    const calls: Call[] = [];
    open(calls);
    window.history.replaceState({}, "", "/?report=r-template");
    const user = userEvent.setup();
    renderWithQuery(<StatusHistory projectId="p1" slug="hop" clock={clock} isAdmin={false} />);
    expect(await screen.findByTestId("template-report")).toHaveTextContent("One requirement moved.");
    expect(screen.getByTestId("template-report")).toHaveTextContent("Narrative not written: risks, recommendations.");
    expect(screen.getByTestId("template-report-export")).toBeInTheDocument();
    await user.click(screen.getByTestId("message-share"));
    await user.click(await screen.findByRole("button", { name: "Create link" }));
    expect(await screen.findByTestId("share-link")).toHaveValue("https://forge.test/s/forge_share_abc");
    expect(calls).toContainEqual({
      method: "POST",
      path: "/projects/p1/shares",
      body: { subjectKind: "status-report", subjectId: "r-template", audience: "members", expiresInDays: 7 },
    });
  });

  it("exports the report as the Markdown core's export route answers, narrative first", () => {
    const file = templateReportFile(TEMPLATE, document);
    expect(file.name).toBe("progress-2026-10-08.md");
    expect(file.text).toContain("## Summary\n\nOne requirement moved.");
    expect(file.text).toContain("Narrative not written: risks, recommendations.");
  });
});
