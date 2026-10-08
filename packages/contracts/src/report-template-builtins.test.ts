import { describe, expect, it } from "vitest";
import { BUILTIN_REPORT_TEMPLATES, builtinReportTemplate } from "./report-template-builtins.js";
import { ReportTemplateSchema } from "./report-templates.js";

// A built-in template is data: it survives a JSON round trip unchanged, which a function or an
// expression could not, and it passes the schema every project template will pass.

describe("the built-in report templates", () => {
  it("are progress, release and roadmap, one each", () => {
    expect(BUILTIN_REPORT_TEMPLATES.map((t) => t.id)).toEqual(["progress", "release", "roadmap"]);
    expect(builtinReportTemplate("release")?.title).toBe("Release readiness");
    expect(builtinReportTemplate("weekly")).toBeUndefined();
  });

  it("hold nothing but data", () => {
    for (const t of BUILTIN_REPORT_TEMPLATES) {
      const round = JSON.parse(JSON.stringify(t));
      expect(round).toEqual(t);
      expect(ReportTemplateSchema.safeParse(round).success).toBe(true);
    }
  });

  it("each name the three narrative slots a model fills", () => {
    for (const t of BUILTIN_REPORT_TEMPLATES) {
      expect(t.narrative.map((n) => n.slot)).toEqual(["summary", "risks", "recommendations"]);
    }
  });
});
