import type { BodyComponentDescriptor } from "@forge/contracts";
import { describe, expect, it } from "vitest";
import { componentSkeleton } from "./body-api";

const review: BodyComponentDescriptor = {
  name: "forge-review",
  root: true,
  leaf: false,
  raw: false,
  ordered: false,
  attrs: [
    { name: "sha", required: true },
    { name: "verdict", required: true, values: ["approve", "request-changes", "abstain"] },
  ],
  slots: [
    { component: "forge-finding", key: "findings", repeat: true, required: false },
    { component: "forge-summary", key: "summary", repeat: false, required: true },
  ],
};

const finding: BodyComponentDescriptor = {
  name: "forge-finding",
  root: false,
  leaf: false,
  raw: false,
  ordered: false,
  attrs: [
    { name: "file", required: true },
    { name: "line", required: false },
    { name: "severity", required: true, values: ["bug", "risk", "nit", "question"] },
  ],
  slots: [],
};

const summary: BodyComponentDescriptor = {
  name: "forge-summary",
  root: false,
  leaf: false,
  raw: false,
  ordered: false,
  attrs: [],
  slots: [],
};

const diagram: BodyComponentDescriptor = {
  name: "forge-diagram",
  root: true,
  leaf: true,
  raw: true,
  ordered: false,
  attrs: [{ name: "kind", required: true, values: ["mermaid"] }],
  slots: [],
};

const byName = new Map([review, finding, summary, diagram].map((d) => [d.name, d]));

describe("componentSkeleton", () => {
  it("writes every attribute the kernel requires, so the insert is not refused", () => {
    const out = componentSkeleton(review, byName);
    expect(out).toContain('sha=""');
    expect(out).toContain('verdict="approve"');
  });

  it("writes the required slots", () => {
    expect(componentSkeleton(review, byName)).toBe(
      '<forge-review sha="" verdict="approve">\n  <forge-summary></forge-summary>\n</forge-review>',
    );
  });

  it("leaves an optional repeating slot out — an empty one is a finding nobody made", () => {
    expect(componentSkeleton(review, byName)).not.toContain("forge-finding");
  });

  it("seeds a non-repeating slot's own required attributes", () => {
    const outcome: BodyComponentDescriptor = {
      name: "forge-outcome",
      root: true,
      leaf: false,
      raw: false,
      ordered: false,
      attrs: [{ name: "kind", required: true, values: ["done", "changed", "note"] }],
      slots: [{ component: "forge-finding", key: "f", repeat: false, required: true }],
    };
    expect(componentSkeleton(outcome, byName)).toContain(
      '<forge-finding file="" severity="bug"></forge-finding>',
    );
  });

  it("leaves a raw component's body empty rather than seeding it with markup", () => {
    expect(componentSkeleton(diagram, byName)).toBe(
      '<forge-diagram kind="mermaid">\n\n</forge-diagram>',
    );
  });

  it("gives a slotless component room to type in", () => {
    expect(componentSkeleton(summary, byName)).toBe("<forge-summary>\n\n</forge-summary>");
  });
});
