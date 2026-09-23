// @vitest-environment jsdom
//
// ISS-1119 — the compact rail is the default desktop navigation and its content
// runs to 999px, so with no scroll region inside it the footer holding the
// version was laid out past the rail's box and clipped by the shell's
// `div.flex.h-dvh.overflow-hidden`: in the DOM at y=987 and painted nowhere at
// 1366x768, reachable by no wheel gesture because the ancestor is
// `overflow: hidden` and the page scrolls the whole shell away instead.
//
// The contract below is what fixes it: one region absorbs the overflow, it
// holds the tiers, the footer is outside it. Whether the footer is PAINTED is
// not something jsdom can answer — the deployed walk is this project's
// instrument for that, and the browser measurement is attached to the issue.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NavRailCompact, type RailItem } from "./nav-rail-compact";

afterEach(cleanup);

const WORKSPACE: RailItem[] = [
	{ key: "overview", label: "Overview", icon: "grid" },
	{ key: "conversations", label: "Conversations", icon: "agent" },
	{ key: "runners", label: "Runners", icon: "server" },
	{ key: "resources", label: "Resources", icon: "lock" },
	{ key: "integrations", label: "Integrations", icon: "link" },
];

const PROJECT: RailItem[] = [
	{ key: "proj-overview", label: "Dashboard", icon: "grid" },
	{ key: "proj-issues", label: "Issues", icon: "list" },
	{ key: "proj-agents", label: "Agents", icon: "agent" },
	{ key: "proj-library", label: "Library", icon: "book" },
	{ key: "proj-automation", label: "Automation", icon: "calendar" },
];

const ACTIVE = { name: "Forge", initials: "FO", tint: "#eee", ink: "#333", liveRuns: 0 };

function renderRail() {
	return render(
		<NavRailCompact
			workspaceItems={WORKSPACE}
			projectItems={PROJECT}
			activeKey="proj-issues"
			activeSlug="forge-dev"
			activeProject={ACTIVE}
			switcherProjects={[]}
			onNavigate={() => {}}
			onSelectProject={() => {}}
			onTogglePin={() => {}}
			onAllProjects={() => {}}
			onNewProject={() => {}}
			onAccount={() => {}}
			onWhatsNew={() => {}}
			onDocs={() => {}}
			onExpand={() => {}}
			userInitials="FO"
			version={<p data-testid="rail-version">Forge v0.3.0</p>}
		/>,
	);
}

describe("what the compact rail lets outgrow it", () => {
	it("scrolls its tiers", () => {
		renderRail();

		expect(screen.getByTestId("rail-tiers").className).toContain("overflow-y-auto");
	});

	it("gives that region a height it can shrink to, so it yields rather than pushing", () => {
		renderRail();

		const cls = screen.getByTestId("rail-tiers").className;
		expect(cls).toContain("min-h-0");
		expect(cls).toContain("flex-1");
	});

	it("puts every navigation row inside it", () => {
		renderRail();

		const tiers = screen.getByTestId("rail-tiers");
		for (const item of [...PROJECT, ...WORKSPACE]) {
			expect(tiers.contains(screen.getByLabelText(item.label))).toBe(true);
		}
	});

	it("keeps the version out of it, so the number never scrolls out of the rail", () => {
		renderRail();

		const tiers = screen.getByTestId("rail-tiers");
		expect(tiers.contains(screen.getByTestId("rail-version"))).toBe(false);
	});

	it("keeps the account menu and the footer buttons out of it too", () => {
		renderRail();

		const tiers = screen.getByTestId("rail-tiers");
		for (const label of ["Account menu", "Docs", "What's New"]) {
			expect(tiers.contains(screen.getByLabelText(label))).toBe(false);
		}
	});

	it("has exactly one region that absorbs the overflow", () => {
		const { container } = renderRail();

		const nav = container.querySelector("nav");
		const scrollers = nav?.querySelectorAll('[class*="overflow-y-auto"]') ?? [];
		expect(scrollers.length).toBe(1);
	});

	it("keeps the project switcher outside it, so its flyout is not clipped", () => {
		renderRail();

		const tiers = screen.getByTestId("rail-tiers");
		expect(tiers.contains(screen.getByLabelText("Switch project — current Forge"))).toBe(false);
	});
});
