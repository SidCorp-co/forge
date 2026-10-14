import { describe, expect, it } from "vitest";
import { secondaryHref, subjectHref } from "./subject";

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
