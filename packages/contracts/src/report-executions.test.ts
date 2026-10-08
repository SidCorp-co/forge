import { describe, expect, it } from "vitest";
import { ComputeRequestSchema, EXECUTION_MAX_INPUTS, framesFromOutput, normalizeScript } from "./report-executions.js";

describe("a script as its fingerprint reads it", () => {
  const script = "for r in rows:\n    total += r['n']\nprint(total)";

  it("does not change with line endings, trailing or inner spacing, or blank lines", () => {
    const spaced = "\r\nfor  r in\trows:   \r\n\r\n    total +=  r['n']\r\nprint(total)  \n\n";
    expect(normalizeScript(spaced)).toBe(normalizeScript(script));
  });

  it("changes with a line's indentation, which is a Python block", () => {
    expect(normalizeScript("for r in rows:\ntotal += r['n']\nprint(total)")).not.toBe(normalizeScript(script));
  });
});

describe("a compute request", () => {
  it("names runs as its inputs, never frames or tables, and at most eight", () => {
    const ok = { language: "python", script: "print(1)", inputs: ["run-1"] };
    expect(ComputeRequestSchema.safeParse(ok).success).toBe(true);
    expect(ComputeRequestSchema.safeParse({ ...ok, inputs: [{ fields: [], rows: [] }] }).success).toBe(false);
    expect(ComputeRequestSchema.safeParse({ ...ok, table: "issues" }).success).toBe(false);
    const many = Array.from({ length: EXECUTION_MAX_INPUTS + 1 }, (_, i) => `run-${i}`);
    expect(ComputeRequestSchema.safeParse({ ...ok, inputs: many }).success).toBe(false);
  });
});

describe("the frames a script hands back", () => {
  it("reads frames.json, and names one that is not frames", () => {
    const frame = { fields: [{ name: "n", type: "number", label: "N" }], rows: [{ n: 1 }] };
    expect(framesFromOutput("frames.json", JSON.stringify({ frames: [frame] }))).toEqual({ ok: true, frames: [frame] });
    expect(framesFromOutput("frames.json", "[1,")).toMatchObject({ ok: false, why: expect.stringContaining("not JSON") });
    expect(framesFromOutput("frames.json", "{}")).toEqual({ ok: false, why: 'frames.json holds no "frames" array' });
  });

  it("reads one table from frames.csv, quoted cells whole and numbers as numbers", () => {
    const read = framesFromOutput("frames.csv", 'team,open\r\n"Core, ""API""",3\nWeb,\n');
    expect(read).toEqual({
      ok: true,
      frames: [
        {
          fields: [
            { name: "team", type: "string", label: "team" },
            { name: "open", type: "number", label: "open" },
          ],
          rows: [
            { team: 'Core, "API"', open: 3 },
            { team: "Web", open: null },
          ],
        },
      ],
    });
  });

  it("names a frames.csv row whose cells do not match its header", () => {
    expect(framesFromOutput("frames.csv", "a,b\n1\n")).toEqual({
      ok: false,
      why: "frames.csv row 2 has 1 cells, and the header names 2",
    });
  });
});
