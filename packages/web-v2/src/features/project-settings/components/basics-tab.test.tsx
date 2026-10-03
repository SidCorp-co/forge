// @vitest-environment jsdom
//
// A project's name is its project document's `project.name`: Basics renames by writing that
// document at the revision it read, and PATCH /api/projects/:id is never the door.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";

expect.extend(matchers);

const write = vi.fn();
let held: unknown;
vi.mock("../config-hooks", () => ({
  useProjectDocument: () => ({ data: held }),
  useWriteProjectDocument: () => ({ mutate: write, isPending: false, error: null }),
}));
const patch = vi.fn();
vi.mock("../hooks", () => ({ useUpdateProject: () => ({ mutate: patch, isPending: false }) }));

vi.mock("@/features/content-language/components/content-language-field", () => ({
  ContentLanguageField: () => null,
}));

const { BasicsTab } = await import("./basics-tab");

const project = { id: "p1", slug: "p-one", name: "Old name" } as ProjectDetail;
const document = {
  version: 1,
  project: { id: "p1", slug: "p-one", name: "Old name" },
  source: { type: "none" },
};

afterEach(() => {
  cleanup();
  write.mockClear();
  patch.mockClear();
});

describe("renaming a project", () => {
  it("writes the project document at the revision it read, changing only project.name", () => {
    held = { declared: true, revision: 3, document };
    render(<BasicsTab project={project} canEdit />);
    fireEvent.change(screen.getByDisplayValue("Old name"), { target: { value: " New name " } });
    fireEvent.click(screen.getByRole("button", { name: "Save basics" }));

    expect(write).toHaveBeenCalledWith({
      baseRevision: 3,
      document: { ...document, project: { ...document.project, name: "New name" } },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("offers no rename for a project with no document, and says where the name lives", () => {
    held = { declared: false, revision: null, document: null };
    render(<BasicsTab project={project} canEdit />);

    expect(screen.getByText(/no project document yet/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Old name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save basics" })).toBeDisabled();
  });
});
