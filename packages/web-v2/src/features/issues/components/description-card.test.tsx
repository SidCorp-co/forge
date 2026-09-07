// @vitest-environment jsdom
//
// ISS-967 gap 4 — `PatchIssueInput` carried only priority and complexity, so a
// description typed wrong at create could not be corrected from the browser at
// all. These pin the affordance, what it sends, and that Cancel discards.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "../types";
import { DescriptionCard } from "./description-card";

expect.extend(matchers);

const save = vi.fn();
let pending = false;

vi.mock("../hooks", () => ({
  useSaveDescription: () => ({ mutate: save, isPending: pending }),
}));

vi.mock("./body-editor", () => ({
  BodyEditor: ({
    value,
    onChange,
    actions,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    actions?: React.ReactNode;
    label: string;
  }) => (
    <div>
      <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      {actions}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  save.mockReset();
  pending = false;
});

const issue = (description: string | null): IssueDetail =>
  ({ id: "i1", description, descriptionFormat: "markdown" }) as IssueDetail;

describe("DescriptionCard", () => {
  it("offers no edit affordance to someone who may not write", () => {
    render(<DescriptionCard issue={issue("hello")} attachments={[]} canWrite={false} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("sends the edited body on the field the server accepts", () => {
    render(<DescriptionCard issue={issue("before")} attachments={[]} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: { value: "after" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(save).toHaveBeenCalledWith(
      { id: "i1", body: { description: "after" } },
      expect.anything(),
    );
  });

  it("discards the draft on Cancel and shows the stored body again", () => {
    render(<DescriptionCard issue={issue("before")} attachments={[]} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: { value: "throwaway" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("before")).toBeInTheDocument();
  });

  it("starts the editor from the stored body, so an edit is a correction not a rewrite", () => {
    render(<DescriptionCard issue={issue("stored text")} attachments={[]} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Issue description")).toHaveValue("stored text");
  });

  it("shows the write in flight rather than an idle-looking button", () => {
    pending = true;
    render(<DescriptionCard issue={issue("before")} attachments={[]} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = [...screen.getAllByRole("button")].find((b) => b.textContent?.includes("Save"));
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
  });

  it("invites the first description rather than reporting an absence", () => {
    render(<DescriptionCard issue={issue(null)} attachments={[]} canWrite />);
    expect(screen.getByText(/No description yet/)).toBeInTheDocument();
  });
});
