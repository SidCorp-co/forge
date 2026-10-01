// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { RepoTab } from "./repo-tab";

const project = (baseBranch: string | null) => ({ id: "p1", baseBranch }) as unknown as ProjectDetail;

describe("RepoTab", () => {
	it("shows the document's default branch and offers no field that would PATCH it", () => {
		render(<RepoTab project={project("trunk")} canEdit />);
		expect(screen.getByText("trunk", { selector: "code" })).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says the branch is not declared where the document names none", () => {
		render(<RepoTab project={project(null)} canEdit />);
		expect(screen.getByText("not declared", { selector: "code" })).toBeTruthy();
	});
});
