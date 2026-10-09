// The live QA of ISS-422 (2026-10-08): a template report could be run and kept only through the
// Assistant or REST. The status page's Templates tab runs one as the reader, draws its document with
// the shared report body, and keeps it with one Save report, after which the history lists it. QA of
// dev.213 (REQ-32 BC-7): the run here drew visuals only; core now writes the summary, risks and
// recommendations on every run, and this page draws them, says how they were written, and keeps them.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { TemplateRun } from "./template-run";

const P = "p1";

const document = {
  templateId: "progress",
  version: 2,
  params: { days: 7 },
  runs: [
    { runId: "r-a", queryId: "progress-by-requirement", asOf: "2026-10-08T03:50:00Z", params: {}, frame: { fields: [], rows: [] } },
    { runId: "r-b", queryId: "criteria-coverage", asOf: "2026-10-08T03:50:00Z", params: {}, frame: { fields: [], rows: [] } },
  ],
  blocks: [],
  narrative: { summary: "Closed work rose.", risks: "Work was sent back.", recommendations: "Find why." },
};
const written = { path: "written", reason: null, model: "m", calls: 1 };

const listing = {
  templates: [
    { id: "progress", version: 2, title: "Progress", params: ["days"] },
    { id: "release", version: 1, title: "Release readiness", params: [] },
  ],
};

function core(save: () => { status?: number; body: unknown } = () => ({ status: 201, body: { id: "rep-9" } })) {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === `/projects/${P}/report-templates`) return { body: listing };
    if (call.method === "POST" && call.path === `/projects/${P}/report-templates/progress/runs`) return { body: { document, narrative: written, slots: [], notDrawn: [], text: "" } };
    if (call.method === "POST" && call.path === `/projects/${P}/status/reports`) return save();
    return undefined;
  });
}

describe("running a template from the status page", () => {
  it("runs the chosen template with the params filled, then keeps its runs with one Save report", async () => {
    const calls = core();
    const user = userEvent.setup();
    renderWithQuery(<TemplateRun projectId={P} slug="hop" />);
    await user.type(await screen.findByLabelText("Period, in days (compared with the period before)"), "7");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("template-run-document");
    expect(calls.find((c) => c.path.endsWith("/runs"))?.body).toEqual({ params: { days: 7 } });
    expect(screen.getByTestId("template-run-narrative")).toHaveTextContent("Summary written by m.");
    expect(screen.getByText("Work was sent back.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save report" }));
    const saved = await screen.findByTestId("template-run-saved");
    expect(calls.find((c) => c.path.endsWith("/status/reports"))?.body).toEqual({
      templateId: "progress",
      runIds: ["r-a", "r-b"],
      narrative: document.narrative,
      findings: [],
    });
    expect(saved.getAttribute("href")).toBe("/projects/hop/status?tab=history&report=rep-9");
  });

  it("sends no param left empty, and offers Save only once a run is drawn", async () => {
    const calls = core();
    const user = userEvent.setup();
    renderWithQuery(<TemplateRun projectId={P} slug="hop" />);
    await screen.findByLabelText("Period, in days (compared with the period before)");
    expect(screen.queryByRole("button", { name: "Save report" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("template-run-document");
    expect(calls.find((c) => c.path.endsWith("/runs"))?.body).toEqual({ params: {} });
  });

  it("reads core's refusal of the save by name", async () => {
    core(() => ({
      status: 422,
      body: { code: "REPORT_RUN_NOT_FOUND", message: "refused", error: { code: "REPORT_RUN_NOT_FOUND", message: "refused", refusals: [{ code: "REPORT_RUN_NOT_FOUND", path: "/runId", detail: "no report run r-a is kept" }] } },
    }));
    const user = userEvent.setup();
    renderWithQuery(<TemplateRun projectId={P} slug="hop" />);
    await screen.findByLabelText("Period, in days (compared with the period before)");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("template-run-document");
    await user.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() => expect(screen.getByTestId("template-run-refusal")).toHaveTextContent("no report run r-a is kept"));
  });
});
