// @vitest-environment jsdom
//
// ISS-936 — the Project Facts tab is the surface that told the owner an
// always-inject fact is one "the agent must always follow". Nothing checks that,
// so the tab now renders the server's `alwaysInjectGuarantee` sentence instead
// of making the promise. These assertions are on the DOM the owner reads.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFactsTab } from "./components/project-facts-tab";

expect.extend(matchers);
afterEach(cleanup);

const useProjectFacts = vi.fn();
const useUpdateProjectFacts = vi.fn();

vi.mock("./hooks", () => ({
	useProjectFacts: (...args: unknown[]) => useProjectFacts(...args),
	useUpdateProjectFacts: (...args: unknown[]) => useUpdateProjectFacts(...args),
}));

const GUARANTEE =
	"Flagging a fact always-inject guarantees it is READ, never that it was DONE: the body reaches every agent prompt, and nothing checks whether the agent followed it.";

function withFacts(overrides: Record<string, unknown> = {}) {
	useProjectFacts.mockReturnValue({
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
		data: {
			projectFacts: { "change-contract": "Report what you hit." },
			projectFactsConfig: { "change-contract": { alwaysInject: true } },
			maxAlwaysInjectChars: 6000,
			alwaysInjectGuarantee: GUARANTEE,
			...overrides,
		},
	});
	useUpdateProjectFacts.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

describe("ProjectFactsTab — what the always-inject flag promises", () => {
	it("shows the guarantee the server served", () => {
		withFacts();
		render(<ProjectFactsTab projectId="proj-1" canEdit={true} />);

		expect(screen.getByText(GUARANTEE)).toBeInTheDocument();
	});

	it("makes the owner no promise that a flagged rule is followed", () => {
		withFacts();
		const { container } = render(
			<ProjectFactsTab projectId="proj-1" canEdit={true} />,
		);

		const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
		expect(onScreen).not.toMatch(/the agent must|must always follow/);
	});

	it("says only that the body reaches every prompt", () => {
		withFacts();
		const { container } = render(
			<ProjectFactsTab projectId="proj-1" canEdit={true} />,
		);

		const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
		expect(onScreen).toContain("agent prompt, so an agent cannot miss it");
	});

	// cm:guard the sentence is SERVED, so an older API answer has none — the paragraph must not render empty rather than not render at all.
	it("renders no empty paragraph when the server sent no sentence", () => {
		withFacts({ alwaysInjectGuarantee: "" });
		const { container } = render(
			<ProjectFactsTab projectId="proj-1" canEdit={true} />,
		);

		const empties = Array.from(container.querySelectorAll("p")).filter(
			(p) => (p.textContent ?? "").trim() === "",
		);
		expect(empties).toHaveLength(0);
	});
});
