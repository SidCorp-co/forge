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

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavRailCompact, type RailEntry, type RailItem } from "./nav-rail-compact";

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

	it("keeps the account menu and the expand button out of it too", () => {
		renderRail();

		const tiers = screen.getByTestId("rail-tiers");
		for (const label of ["Account menu", "Expand sidebar"]) {
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

// A label is bounded by its button, whatever its length: the rail's width buys
// today's labels room, and the truncation is what holds when a longer one or a
// translation arrives. jsdom lays nothing out, so this reads the bound itself;
// the rendered geometry is measured in a browser.
describe("a nav label and its button", () => {
	const LONG = "Integrations and external services";

	function labelOf(name: string): HTMLElement {
		const button = screen.getByRole("button", { name });
		const span = button.querySelector("span:not([aria-hidden])");
		if (!(span instanceof HTMLElement)) throw new Error(`no label span in ${name}`);
		return span;
	}

	it("bounds every label to its button's width and truncates the rest", () => {
		renderRail();

		for (const item of [...PROJECT, ...WORKSPACE]) {
			const cls = labelOf(item.label).className.split(/\s+/);
			expect(cls).toEqual(expect.arrayContaining(["block", "min-w-0", "max-w-full", "truncate"]));
		}
	});

	it("gives every button a fixed width narrower than the rail", () => {
		const { container } = renderRail();

		expect(container.querySelector("nav")?.className).toContain("w-[88px]");
		for (const item of [...PROJECT, ...WORKSPACE]) {
			expect(screen.getByRole("button", { name: item.label }).className).toContain("w-[76px]");
		}
	});

	it("shows the full label on hover, so a truncated one can still be read", () => {
		render(
			<NavRailCompact
				workspaceItems={[{ key: "long", label: LONG, icon: "link" }]}
				activeKey="long"
				switcherProjects={[]}
				onNavigate={() => {}}
				onSelectProject={() => {}}
				onTogglePin={() => {}}
				onAllProjects={() => {}}
				onNewProject={() => {}}
			/>,
		);

		const button = screen.getByRole("button", { name: LONG });
		expect(button.getAttribute("title")).toBe(LONG);
		expect(labelOf(LONG).className).toContain("truncate");
	});

	it("pins the active bar inside the rail rather than past its left edge", () => {
		renderRail();

		const bar = screen.getByRole("button", { name: "Issues" }).querySelector("span[aria-hidden]");
		expect(bar?.className).toContain("left-[-6px]");
	});
});

// The owner's IA (ISS-65): the build machinery sits under one Development head in the compact rail
// as it does in the expanded one, open while it holds the current page, and its counts surface on
// the head while it is folded.
describe("a group in the compact rail", () => {
	const GROUPED: RailEntry[] = [
		{ key: "proj-overview", label: "Dashboard", icon: "grid" },
		{
			key: "development",
			label: "Development",
			icon: "code",
			items: [
				{ key: "proj-issues", label: "Issues", icon: "list", badge: 4 },
				{ key: "proj-contracts", label: "Contracts", icon: "link", badge: 2 },
			],
		},
	];

	function renderGrouped(activeKey: string, groupOpen: Record<string, boolean> = {}, onToggleGroup = vi.fn()) {
		render(
			<NavRailCompact
				workspaceItems={WORKSPACE}
				projectItems={GROUPED}
				groupOpen={groupOpen}
				onToggleGroup={onToggleGroup}
				activeKey={activeKey}
				activeProject={ACTIVE}
				switcherProjects={[]}
				onNavigate={() => {}}
				onSelectProject={() => {}}
				onTogglePin={() => {}}
				onAllProjects={() => {}}
				onNewProject={() => {}}
			/>,
		);
		return onToggleGroup;
	}

	it("is open, its rows listed, while it holds the current page", () => {
		renderGrouped("proj-issues");

		expect(screen.getByRole("button", { name: "Development" }).getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("button", { name: "Issues" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("button", { name: "Contracts" })).toBeTruthy();
	});

	it("folds its rows away elsewhere and carries their counts on the head", () => {
		renderGrouped("proj-overview");

		const head = screen.getByRole("button", { name: "Development" });
		expect(head.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("button", { name: "Issues" })).toBeNull();
		expect(head.textContent).toContain("6");
	});

	it("asks to open when its head is pressed", () => {
		const toggle = renderGrouped("proj-overview");

		fireEvent.click(screen.getByRole("button", { name: "Development" }));
		expect(toggle).toHaveBeenCalledWith("development", true);
	});
});
