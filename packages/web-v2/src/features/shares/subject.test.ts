// What "Save report" on a chat answer keeps: the template the turn ran, its runs in order, and the
// narrative the turn's last template output carries, its written slots only. An answer that ran no
// template, or whose call failed, offers nothing to save.

import { describe, expect, it } from "vitest";
import { templateSaveOf } from "./subject";

const call = (output: unknown, isError = false) => ({
  type: "tool",
  toolCall: { name: "mcp__forge__forge_template", output: JSON.stringify(output), ...(isError ? { isError } : {}) },
});

const doc = (runs: string[], narrative: Record<string, string> = {}) => ({
  document: { templateId: "progress", runs: runs.map((runId) => ({ runId })), narrative },
});

const answer = (blocks: unknown[]) => ({ role: "assistant", blocks });

describe("templateSaveOf", () => {
  it("keeps the template, its runs in order and the written slots of the last output", () => {
    expect(
      templateSaveOf(
        answer([
          call(doc(["r-a", "r-b"])),
          call(doc(["r-a", "r-b"], { summary: "Two of three requirements are proven.", risks: "  ", recommendations: "" })),
          { type: "text", text: "Here it is." },
        ]),
      ),
    ).toEqual({ templateId: "progress", runIds: ["r-a", "r-b"], narrative: { summary: "Two of three requirements are proven." }, findings: [] });
  });

  it("keeps each block's finding in order, an empty one where a block has none", () => {
    const output = { document: { templateId: "progress", runs: [{ runId: "r-a" }], narrative: {}, blocks: [{ finding: "Closed rose." }, {}] } };
    expect(templateSaveOf(answer([call(output)]))?.findings).toEqual(["Closed rose.", ""]);
  });

  it("offers nothing for prose, a failed call, an output that is no document, or a person's turn", () => {
    expect(templateSaveOf(answer([{ type: "text", text: "Plain words." }]))).toBeNull();
    expect(templateSaveOf(answer([call(doc(["r-a"]), true)]))).toBeNull();
    expect(templateSaveOf(answer([call("not a document")]))).toBeNull();
    expect(templateSaveOf({ role: "user", blocks: [call(doc(["r-a"]))] })).toBeNull();
  });

  it("offers nothing for a document naming a run with no id", () => {
    expect(templateSaveOf(answer([call({ document: { templateId: "progress", runs: [{ runId: "" }], narrative: {} } })]))).toBeNull();
  });
});
