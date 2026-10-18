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

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const ACTIVE = { name: "Forge", initials: "FO", tint: "#eee", ink: "#333", liveSessions: 0, liveSessionsRead: "read" as const };

function renderRail(over: { activeProject?: typeof ACTIVE | { name: string; initials: string; tint: string; ink: string; liveSessions: number | null; liveSessionsRead: "pending" | "failed" | "read" }; switcherProjects?: Parameters<typeof NavRailCompact>[0]["switcherProjects"] } = {}) {
	return render(
		<NavRailCompact
			workspaceItems={WORKSPACE}
			projectItems={PROJECT}
			activeKey="proj-issues"
			activeSlug="forge-dev"
			activeProject={over.activeProject ?? ACTIVE}
			switcherProjects={over.switcherProjects ?? []}
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

// ISS-1156 — the live-session label under the project mark is stated only from a health read that came
// in. A pending or failed read is drawn as its own mark with a name, never as the absence of a count.
describe("the live sessions under the project mark", () => {
	const unread = (liveSessionsRead: "pending" | "failed") => ({ ...ACTIVE, liveSessions: null, liveSessionsRead });

	it("says the read failed, by name, instead of drawing nothing", () => {
		renderRail({ activeProject: unread("failed") });
		expect(screen.getByLabelText("how many live sessions could not be read").textContent).toBe("!");
	});

	it("says the read is on its way", () => {
		renderRail({ activeProject: unread("pending") });
		expect(screen.getByLabelText("reading how many live sessions").textContent).toBe("…");
	});

	it("states the count where the read came in, and draws nothing for a read zero", () => {
		renderRail({ activeProject: { ...ACTIVE, liveSessions: 3 } });
		expect(screen.getByText("3 live")).toBeTruthy();
		cleanup();
		renderRail();
		expect(screen.queryByText(/live/)).toBeNull();
		expect(screen.queryByLabelText(/read/)).toBeNull();
	});

	it("names the failed read on the switcher row of a project, not as a project with no live session", () => {
		const row = (liveSessionsRead: "pending" | "failed" | "read", liveSessions: number | null) => ({
			id: "p1", slug: "forge-dev", name: "Forge", initials: "FO", tint: "#eee", ink: "#333", pinned: false, liveSessions, liveSessionsRead,
		});
		renderRail({ switcherProjects: [row("failed", null)] });
		fireEvent.click(screen.getByRole("button", { name: /Switch project/ }));
		expect(within(screen.getByRole("dialog")).getByLabelText("how many live sessions could not be read").textContent).toBe("!");
	});
});

// ISS-1268 — the project switcher's panel closed only on an outside press, so a keyboard user who
// opened it could not leave it: Escape did nothing and focus stayed in the find field. Menu and the
// Help popover close on Escape and give focus back to their trigger; this surface has to as well.
describe("the project switcher and the Escape key", () => {
	const row = (id: string, name: string) => ({
		id, slug: id, name, initials: name.slice(0, 2).toUpperCase(), tint: "#eee", ink: "#333", pinned: false, liveSessions: 0, liveSessionsRead: "read" as const,
	});
	const PROJECTS = [row("forge-dev", "Forge"), row("epod", "Epod")];

	function openSwitcher() {
		renderRail({ switcherProjects: PROJECTS });
		const trigger = screen.getByRole("button", { name: /Switch project/ });
		fireEvent.click(trigger);
		return trigger;
	}
	const pressEscape = (on: Element | null = document.activeElement) => fireEvent.keyDown(on ?? document.body, { key: "Escape" });

	it("closes on Escape pressed in the find field, and gives focus back to the switcher button", () => {
		const trigger = openSwitcher();
		const field = screen.getByPlaceholderText("Find a project…");
		expect(document.activeElement).toBe(field);

		pressEscape();

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on Escape pressed on a project row, a pin button and the footer buttons", () => {
		const targets: ((panel: HTMLElement) => HTMLElement)[] = [
			(panel) => within(panel).getByText("Epod").closest("button") as HTMLElement,
			(panel) => within(panel).getByRole("button", { name: "Pin Epod" }),
			(panel) => within(panel).getByRole("button", { name: "View all" }),
			(panel) => within(panel).getByRole("button", { name: "New project" }),
		];
		for (const find of targets) {
			const trigger = openSwitcher();
			const target = find(screen.getByRole("dialog"));
			target.focus();

			pressEscape(target);

			expect(screen.queryByRole("dialog")).toBeNull();
			expect(document.activeElement).toBe(trigger);
			cleanup();
		}
	});

	it("stays open for every other key, and typing in the field still filters the rows", () => {
		openSwitcher();
		const field = screen.getByPlaceholderText("Find a project…");

		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.keyDown(field, { key: "Tab" });
		fireEvent.change(field, { target: { value: "epo" } });

		const panel = screen.getByRole("dialog");
		expect(within(panel).queryByText("Forge")).toBeNull();
		expect(within(panel).getByText("Epod")).toBeTruthy();
	});

	it("still closes on a press outside the panel", () => {
		openSwitcher();

		fireEvent.mouseDown(document.body);

		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("leaves the rail alone when Escape is pressed with the panel closed", () => {
		renderRail({ switcherProjects: PROJECTS });
		const issues = screen.getByRole("button", { name: "Issues" });
		issues.focus();

		pressEscape(issues);

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(issues);
	});
});

// ISS-1229 r16, judge-41: What's New drew the notifications bell with a dot of its own, so a dot stayed
// beside the bell after the bell said "You're all caught up". It draws an icon of its own.
describe("the What's New button", () => {
	it("draws an icon that is not the notifications bell", () => {
		renderRail();

		const svg = screen.getByLabelText("What's New").querySelector("svg");
		expect(svg?.getAttribute("class")).toContain("lucide-megaphone");
		expect(svg?.getAttribute("class")).not.toContain("lucide-bell");
	});
});
