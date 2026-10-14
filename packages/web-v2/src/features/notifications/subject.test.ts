import { describe, expect, it } from "vitest";
import { memberTexts, secondaryHref, subjectHref } from "./subject";

const ISSUE = "11111111-1111-4111-8111-111111111111";

describe("subjectHref", () => {
  it("opens the issue a notification is about", () => {
    expect(subjectHref({ type: "issue_stranded", projectSlug: "invoicing", issueId: ISSUE })).toBe(
      `/projects/invoicing/issues/${ISSUE}`,
    );
  });

  it("opens the skill updates a reconcile gate waits on, issue or not", () => {
    expect(subjectHref({ type: "reconcile_gate_pending", projectSlug: "invoicing", issueId: ISSUE })).toBe(
      "/projects/invoicing/library?tab=updates",
    );
  });

  it("opens the project where no issue is named", () => {
    expect(subjectHref({ type: "pipeline_wedge", projectSlug: "invoicing", issueId: null })).toBe(
      "/projects/invoicing",
    );
  });

  it("opens the ops page for a platform alert, and nothing for a project-less other", () => {
    expect(subjectHref({ type: "ops_alert", projectSlug: null, issueId: null })).toBe("/ops");
    expect(subjectHref({ type: "pipeline_wedge", projectSlug: null, issueId: ISSUE })).toBeNull();
  });
});

describe("secondaryHref", () => {
  it("opens the issue a stall waits on, and nothing without one", () => {
    expect(secondaryHref({ projectSlug: "invoicing", secondaryIssueId: ISSUE })).toBe(
      `/projects/invoicing/issues/${ISSUE}`,
    );
    expect(secondaryHref({ projectSlug: "invoicing", secondaryIssueId: null })).toBeNull();
    expect(secondaryHref({ projectSlug: null, secondaryIssueId: ISSUE })).toBeNull();
  });
});

describe("memberTexts", () => {
  const m = (title: string, projectId: string | null, projectName: string | null, projectSlug: string | null) => ({
    title,
    projectId,
    projectName,
    projectSlug,
  });

  it("leaves a group inside one project as its records titled", () => {
    expect(memberTexts([m("ISS-1 a", "p1", "Invoicing", "invoicing"), m("ISS-3 b", "p1", "Invoicing", "invoicing")])).toEqual([
      "ISS-1 a",
      "ISS-3 b",
    ]);
  });

  it("names the project on every record of a group spanning two, so ISS-1 and ISS-1 read apart", () => {
    expect(
      memberTexts([
        m("ISS-1 a", "p1", "Invoicing", "invoicing"),
        m("ISS-3 b", "p1", "Invoicing", "invoicing"),
        m("ISS-1 c", "p2", "Payroll", "payroll"),
      ]),
    ).toEqual(["Invoicing · ISS-1 a", "Invoicing · ISS-3 b", "Payroll · ISS-1 c"]);
  });

  it("leaves a title that already names its project as it is", () => {
    expect(
      memberTexts([m("ISS-1 a — Invoicing", "p1", "Invoicing", "invoicing"), m("ISS-1 c", "p2", "Payroll", "payroll")]),
    ).toEqual(["ISS-1 a — Invoicing", "Payroll · ISS-1 c"]);
  });

  it("uses the slug where two projects share a name", () => {
    expect(
      memberTexts([m("ISS-1 a", "p1", "Web", "web-eu"), m("ISS-1 b", "p2", "Web", "web-us")]),
    ).toEqual(["web-eu · ISS-1 a", "web-us · ISS-1 b"]);
  });
});
