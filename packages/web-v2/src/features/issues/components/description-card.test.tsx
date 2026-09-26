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

const issue = (
  description: string | null,
  over: Partial<IssueDetail> = {},
): IssueDetail =>
  ({
    id: "i1",
    description,
    descriptionFormat: "markdown",
    status: "in_progress",
    ...over,
  }) as IssueDetail;

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

// ISS-1010 — a drive job rewrites a description wholesale (ISS-1010's own thread
// carries four such rewrites of its body), so the Edit affordance is a way to
// lose work while one is running.
describe("DescriptionCard, while an agent is working the issue", () => {
  const held = "An agent is working this — your edit would be overwritten";

  it("offers no Edit control", () => {
    render(
      <DescriptionCard
        issue={issue("body", { agentStatus: "running" })}
        attachments={[]}
        canWrite
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("names the reason where the Edit control was", () => {
    render(
      <DescriptionCard
        issue={issue("body", { agentStatus: "running" })}
        attachments={[]}
        canWrite
      />,
    );
    expect(screen.getByText(held)).toBeInTheDocument();
  });

  it("still offers Edit on a needs_info issue", () => {
    render(
      <DescriptionCard
        issue={issue("body", { status: "needs_info", agentStatus: "running" })}
        attachments={[]}
        canWrite
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByText(held)).toBeNull();
  });

  it("keeps Save on a draft that was already open when the job started", () => {
    const { rerender } = render(
      <DescriptionCard issue={issue("before")} attachments={[]} canWrite />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    rerender(
      <DescriptionCard
        issue={issue("before", { agentStatus: "running" })}
        attachments={[]}
        canWrite
      />,
    );
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: { value: "typed while it ran" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      { id: "i1", body: { description: "typed while it ran" } },
      expect.anything(),
    );
  });

  it("locks nothing while the job is only queued", () => {
    render(
      <DescriptionCard
        issue={issue("body", { agentStatus: "queued" })}
        attachments={[]}
        canWrite
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});

// ISS-1150 — the attachments sit with the text that refers to them.
describe("DescriptionCard's attachments", () => {
  const FILE = {
    id: "a1",
    issueId: "i1",
    uploaderId: "u1",
    createdAt: "2026-09-21T11:01:17.765Z",
    name: "notes.txt",
    mime: "text/plain",
    size: 120,
    url: "/api/attachments/a1/download",
  };
  const at = (name: string) => screen.getByText(name);
  const precedes = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("lists the attachments above the description text", () => {
    render(<DescriptionCard issue={issue("the body")} attachments={[FILE]} canWrite={false} />);
    const region = screen.getByRole("region", { name: "Attachments" });
    expect(region).toHaveTextContent("notes.txt");
    expect(precedes(region, at("the body"))).toBe(true);
  });

  it("renders nothing for attachments when there are none", () => {
    render(<DescriptionCard issue={issue("the body")} attachments={[]} canWrite={false} />);
    expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
    expect(screen.queryByText(/No attachments/)).toBeNull();
  });

  it("says a failed read failed instead of showing none", () => {
    render(
      <DescriptionCard
        issue={issue("the body")}
        attachments={[]}
        attachmentsError={new Error("network down")}
        canWrite={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load attachments");
  });

  it("holds a placeholder while the attachments load", () => {
    const { container } = render(
      <DescriptionCard issue={issue("the body")} attachments={[]} attachmentsLoading canWrite={false} />,
    );
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
  });
});
