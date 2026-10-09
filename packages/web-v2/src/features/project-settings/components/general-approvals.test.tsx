// REQ-34 r2 BC-25: each step's person gate is a switch on General, off where the document says
// nothing, and the readiness choice it replaced is gone.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { Seeded } from "@/test/vi-chrome-requirements";
import { GeneralSection } from "./general-section";

const P = "11111111-1111-4111-8111-111111111111";
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], archivedAt: null } as unknown as ProjectDetail;
const DOC = { $schema: "https://forge.sidcorp.co/schemas/project-v1.json", version: 1, approvals: { designs: true } };

const LABELS = [
  "A person agrees each requirement",
  "A person accepts each requirement revision",
  "A person accepts each breakdown",
  "A person admits each new issue",
  "A person accepts each delivered requirement",
  "A person approves each workflow design",
];

describe("the person gates on General", () => {
  it("shows one switch per step, on only where the document turns it on", () => {
    render(
      <Seeded data={[[["project", P, "config"], { declared: true, revision: 3, document: DOC }]]}>
        <GeneralSection project={DETAIL} canEdit />
      </Seeded>,
    );
    const on = LABELS.map((l) => (screen.getByRole("switch", { name: l }) as HTMLInputElement).getAttribute("aria-checked"));
    expect(on).toEqual(["false", "false", "false", "false", "false", "true"]);
    expect(screen.queryByText("Requirement readiness check")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: LABELS[0] }));
    expect(screen.getByRole("switch", { name: LABELS[0] }).getAttribute("aria-checked")).toBe("true");
  });
});
