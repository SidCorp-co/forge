// A refused save shows core's plain words on the field each refusal's path names (REQ-34 BC-18,
// ISS-457): a field owns its path and everything under it, never a path that only starts with the
// same letters, and the line under the form keeps only what no field owns.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { placeRefusals } from "./field-refusals";
import { RefusalLine } from "./refusal-line";

const refused = (...refusals: { code: string; path: string; detail: string }[]) =>
  new ApiError(422, "refused", refusals[0]?.code, undefined, { error: { code: refusals[0]?.code, message: "refused", refusals } });

const FIELDS = { title: ["/title"], criteria: ["/criteria"], about: ["/requirement", "/workflow"] } as const;

describe("placeRefusals", () => {
  it("puts each refusal on the field that owns its path, or a path under it", () => {
    const placed = placeRefusals(
      refused(
        { code: "BAD_REQUEST", path: "/title", detail: "Write a title." },
        { code: "CRITERION_SCENARIO_UNPARSEABLE", path: "/criteria/1/body", detail: "A scenario reads Given, When, Then." },
        { code: "FEEDBACK_TARGET_UNKNOWN", path: "/workflow", detail: "No workflow is named checkout." },
      ),
      FIELDS,
    );
    expect(placed.at("title")).toBe("Write a title.");
    expect(placed.at("criteria")).toBe("A scenario reads Given, When, Then.");
    expect(placed.at("about")).toBe("No workflow is named checkout.");
  });

  it("joins two refusals on one field, and leaves a path that only shares its first letters to the line", () => {
    const placed = placeRefusals(
      refused(
        { code: "A", path: "/criteria/0/body", detail: "First is empty." },
        { code: "B", path: "/criteria/2/code", detail: "BC-2 appears twice." },
        { code: "C", path: "/criteriaFrom", detail: "That document is not a criteria list." },
        { code: "D", path: "", detail: "The requirement is held." },
      ),
      FIELDS,
    );
    expect(placed.at("criteria")).toBe("First is empty. BC-2 appears twice.");
    expect(placed.onField({ code: "C", path: "/criteriaFrom", detail: "" })).toBe(false);
    expect(placed.onField({ code: "D", path: "", detail: "" })).toBe(false);
    expect(placed.at("title")).toBeUndefined();
  });

  it("places nothing for a failure that named no refusal", () => {
    const placed = placeRefusals(new ApiError(500, "boom"), FIELDS);
    expect(placed.at("title")).toBeUndefined();
  });
});

describe("the refusal line beside placed fields", () => {
  it("draws nothing when every refusal is on a field", () => {
    const error = refused({ code: "BAD_REQUEST", path: "/title", detail: "Write a title." });
    const { container } = render(<RefusalLine error={error} onField={placeRefusals(error, FIELDS).onField} />);
    expect(container.innerHTML).toBe("");
  });

  it("names only what no field owns", () => {
    const error = refused({ code: "BAD_REQUEST", path: "/title", detail: "Write a title." }, { code: "HELD", path: "", detail: "The requirement is held." });
    render(<RefusalLine error={error} onField={placeRefusals(error, FIELDS).onField} />);
    const line = screen.getByTestId("refusal");
    expect(line).toHaveTextContent("The requirement is held.");
    expect(line).not.toHaveTextContent("Write a title.");
  });

  it("still words a failure that named no refusal", () => {
    const error = new ApiError(500, "boom");
    render(<RefusalLine error={error} onField={placeRefusals(error, FIELDS).onField} />);
    expect(screen.getByTestId("refusal")).toBeInTheDocument();
  });
});
