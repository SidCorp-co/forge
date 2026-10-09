// The live QA of ISS-426 (2026-10-08): the weekly status schedule took a day, a time and recipients,
// and no web act scheduled a report template. The schedule form now picks what is sent: the project
// status as before, or one of the build's templates with its params, saved as a status_report
// schedule whose params name the template; a template schedule's line names its template.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ReportSchedule } from "./report-schedule";

const P = "p1";
const ME = "11111111-1111-4111-8111-111111111111";

const row = (params: Record<string, unknown>) => ({
  id: "s1",
  projectId: P,
  name: "Weekly status report",
  cron: "0 9 * * 1",
  prompt: null,
  kind: "status_report",
  script: null,
  enabled: true,
  targetProjectSlug: null,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  lastSessionId: null,
  params,
  timeZone: "UTC",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
});

function core(schedules: unknown[] = []) {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === `/schedules?projectId=${P}`) return { body: schedules };
    if (call.method === "GET" && call.path === `/projects/${P}/members`) {
      return { body: [{ userId: ME, email: "me@forge.test", displayName: "Me", kind: "human", role: "admin", createdAt: "2026-10-01T00:00:00Z" }] };
    }
    if (call.method === "GET" && call.path === `/projects/${P}/report-templates`) {
      return { body: { templates: [{ id: "progress", version: 1, title: "Progress", params: ["days"] }] } };
    }
    if (call.method === "POST" && call.path === "/schedules") return { status: 201, body: row((call.body as { params: Record<string, unknown> }).params) };
    return undefined;
  });
}

describe("scheduling a report template", () => {
  it("saves a status_report schedule naming the template and its params, with no days", async () => {
    const calls = core();
    const user = userEvent.setup();
    renderWithQuery(<ReportSchedule projectId={P} />);
    await screen.findByRole("option", { name: "Progress" });
    await user.selectOptions(screen.getByLabelText("Report"), "progress");
    await user.type(screen.getByLabelText("Period, in days (compared with the period before)"), "7");
    await user.click(await screen.findByRole("checkbox", { name: "Me" }));
    await user.click(screen.getByRole("button", { name: "Send it every week" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeDefined());
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      kind: "status_report",
      name: "Weekly report: Progress",
      params: { recipients: [ME], templateId: "progress", templateParams: { days: 7 } },
    });
  });

  it("keeps the project status as the default, sending recipients only", async () => {
    const calls = core();
    const user = userEvent.setup();
    renderWithQuery(<ReportSchedule projectId={P} />);
    await user.click(await screen.findByRole("checkbox", { name: "Me" }));
    await user.click(screen.getByRole("button", { name: "Send it every week" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeDefined());
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ name: "Weekly status report", params: { recipients: [ME] } });
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("params.templateId");
  });

  it("names the template on a template schedule's line", async () => {
    core([row({ recipients: [ME], templateId: "progress" })]);
    renderWithQuery(<ReportSchedule projectId={P} />);
    expect(await screen.findByTestId("status-schedule-row")).toHaveTextContent("Progress");
  });
});
