import { describe, expect, it } from "vitest";
import { walkedOf } from "./coverage";
import type { WorkflowStep } from "./types";

const step = (id: string, reading?: "walked" | "not_walked"): WorkflowStep => ({
  id,
  does: id,
  status: "current",
  after: [],
  evidence: reading ? { file: `src/${id}.ts`, coverage: { reading, atSha: "a".repeat(40) } } : null,
});

describe("a flow's coverage", () => {
  it("counts only the steps the integration suite walked", () => {
    expect(walkedOf([step("a", "walked"), step("b", "walked"), step("c", "not_walked"), step("d")])).toEqual({ walked: 2, total: 4 });
  });
});
