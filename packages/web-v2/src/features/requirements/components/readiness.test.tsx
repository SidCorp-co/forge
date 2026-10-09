// Nothing schedules a readiness check, so a requirement it never ran on says nothing: no line that
// reads as owed work. Where the BA assistant did check, the line counts what was met, as advice: the
// agree is judged by the ready checklist (ISS-453), so the line never says it gated the agree.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SuggestionView as Suggestion } from "@/features/suggestions/types";
import { Readiness } from "./requirement-proof";

const suggestion = (checks: unknown): Suggestion => ({ kind: "readiness", payload: { checks }, baseRevision: 2 }) as unknown as Suggestion;

describe("the readiness line", () => {
  it("is absent where no check ran, never 'not checked yet'", () => {
    const { container } = render(<Readiness suggestions={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(document.body).not.toHaveTextContent("not checked");
  });

  it("is absent for a check with no results", () => {
    const { container } = render(<Readiness suggestions={[suggestion([])]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the checks met where the BA assistant checked, as advice that gates nothing", () => {
    render(<Readiness suggestions={[suggestion([{ check: "has scope", passed: true }, { check: "has a persona", passed: false }])]} />);
    const line = screen.getByTestId("readiness");
    expect(line).toHaveTextContent("Readiness advice 1 of 2 checks met");
    expect(line.querySelector("[title^='Met · has scope']")).not.toBeNull();
    expect(line.innerHTML).not.toMatch(/before the requirement was agreed/);
  });
});
