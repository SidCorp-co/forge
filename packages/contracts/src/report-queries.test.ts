import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineReportQuery,
  parseReportParams,
  REPORT_FIELD_VOCABULARIES,
  ReportFieldSchema,
  ReportFrameSchema,
  ReportQueryDescriptorViewSchema,
  ReportRunSchema,
} from "./report-queries.js";

const ok = {
  id: "progress-by-requirement",
  version: 1,
  title: "Progress by requirement",
  params: z.object({ limit: z.number().int().optional() }),
  output: [{ name: "key", type: "ref" as const, label: "Requirement" }],
  permission: "project.read" as const,
  egress: "product" as const,
  surfaces: ["rest", "chat"] as const,
};

describe("defineReportQuery", () => {
  it("returns a sound descriptor", () => {
    expect(defineReportQuery(ok)).toBe(ok);
  });

  it.each([
    ["an id that is not kebab-case", { id: "Progress_By" }, "id must be kebab-case"],
    ["a version of zero", { version: 0 }, "version must be an integer of at least 1"],
    ["a fractional version", { version: 1.5 }, "version must be an integer"],
    ["no surface", { surfaces: [] }, "surfaces is empty"],
    ["a surface that does not exist", { surfaces: ["fax"] }, 'surface "fax"'],
    ["a permission that is not a project permission", { permission: "org.read" }, "not a project permission"],
    ["no output", { output: [] }, "output declares no fields"],
    [
      "an output field declared twice",
      { output: [ok.output[0], ok.output[0]] },
      'output declares field "key" twice',
    ],
  ])("refuses %s, naming the query", (_n, patch: Record<string, unknown>, text) => {
    expect(() => defineReportQuery({ ...ok, ...patch } as never)).toThrow(`report query "${String(patch.id ?? ok.id)}"`);
    expect(() => defineReportQuery({ ...ok, ...patch } as never)).toThrow(text);
  });
});

describe("parseReportParams", () => {
  it("returns the params it was given", () => {
    expect(parseReportParams(defineReportQuery(ok), { limit: 3 })).toEqual({ limit: 3 });
  });
  it("refuses an unknown key by name", () => {
    expect(() => parseReportParams(defineReportQuery(ok), { limit: 3, extra: 1 })).toThrow(
      /report query "progress-by-requirement": params refused: .*extra/,
    );
  });
});

describe("ReportFrameSchema", () => {
  const f = { fields: [{ name: "n", type: "number", label: "N" }], rows: [{ n: 1 }] };
  it("accepts a frame", () => expect(ReportFrameSchema.safeParse(f).success).toBe(true));
  it("refuses a duplicate field, a missing cell, an undeclared cell and a cell of the wrong type", () => {
    const msgs = (v: unknown) => {
      const r = ReportFrameSchema.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(msgs({ ...f, fields: [f.fields[0], f.fields[0]] }).join()).toContain('field "n" is declared twice');
    expect(msgs({ ...f, rows: [{}] }).join()).toContain('no cell for field "n"');
    expect(msgs({ ...f, rows: [{ n: 1, z: 2 }] }).join()).toContain('cell "z" that no field declares');
    expect(msgs({ ...f, rows: [{ n: "1" }] }).join()).toContain("is string, but the field is number");
  });
  it("accepts a null cell for any type", () => {
    expect(ReportFrameSchema.safeParse({ ...f, rows: [{ n: null }] }).success).toBe(true);
  });
});

describe("a status field's vocabulary", () => {
  const state = { name: "state", type: "status", label: "State" } as const;
  it("names the shared state family its values are read through", () => {
    for (const vocabulary of REPORT_FIELD_VOCABULARIES) {
      expect(ReportFieldSchema.safeParse({ ...state, vocabulary }).success).toBe(true);
    }
    expect(ReportFieldSchema.safeParse(state).success).toBe(true);
  });
  it("refuses a vocabulary no family carries, naming the ones that exist", () => {
    const r = ReportFieldSchema.safeParse({ ...state, vocabulary: "mood" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["vocabulary"]);
  });
  it("refuses a vocabulary on a field that is not a status, by name", () => {
    const r = ReportFieldSchema.safeParse({ name: "n", type: "number", label: "N", vocabulary: "requirement" });
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      'field "n" is number and names the vocabulary "requirement"; only a status field reads its values through a vocabulary',
    ]);
  });
  it("is refused at definition time, naming the query", () => {
    const bad = { ...ok, output: [{ name: "n", type: "number" as const, label: "N", vocabulary: "requirement" as const }] };
    expect(() => defineReportQuery(bad)).toThrow('report query "progress-by-requirement": output field "n" is invalid');
  });
});

describe("the wire shapes", () => {
  it("a run carries its query, version, actor and moment", () => {
    const run = {
      runId: "r1", queryId: "roadmap-eta", version: 1, params: {}, projectId: "p",
      actor: { kind: "human", id: "u" }, asOf: "2026-10-08T10:00:00Z",
      frame: { fields: [{ name: "n", type: "number", label: "N" }], rows: [] },
    };
    expect(ReportRunSchema.safeParse(run).success).toBe(true);
    expect(ReportRunSchema.safeParse({ ...run, asOf: "yesterday" }).success).toBe(false);
    expect(ReportRunSchema.safeParse({ ...run, queryId: undefined }).success).toBe(false);
  });
  it("a descriptor view refuses a permission below project.read", () => {
    const v = { id: "a", version: 1, title: "t", params: {}, output: [{ name: "n", type: "number", label: "N" }], permission: "project.read", egress: "product", surfaces: ["rest"] };
    expect(ReportQueryDescriptorViewSchema.safeParse(v).success).toBe(true);
    expect(ReportQueryDescriptorViewSchema.safeParse({ ...v, permission: "anyone" }).success).toBe(false);
  });
});
