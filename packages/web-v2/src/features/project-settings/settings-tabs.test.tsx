// @vitest-environment jsdom
//
// Project settings has eight tabs, and every retired `?tab=` address opens the tab holding what it
// named, so a link anyone kept still lands on its content (ISS-1171).

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabParam } from "@/lib/utils/use-tab-param";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/desk/settings" }));

const { TAB_ALIASES, TAB_VALUES, TABS } = await import("./components/project-settings-screen");

function tabAt(search: string) {
	window.history.replaceState(null, "", `/projects/desk/settings${search}`);
	return renderHook(() => useTabParam(TAB_VALUES, "general", TAB_ALIASES)).result.current[0];
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the settings tabs", () => {
	it("are the eight, in order", () => {
		expect(TABS.map((t) => t.label)).toEqual([
			"General",
			"Shape & release",
			"Pipeline",
			"Runners",
			"Integrations",
			"Members",
			"Labels & modules",
			"Memory",
		]);
	});

	it.each([
		["basics", "general"],
		["advanced", "general"],
		["repo", "shape"],
		["testing", "shape"],
		["labels", "taxonomy"],
		["modules", "taxonomy"],
	])("open ?tab=%s on the %s tab", (old, now) => {
		expect(tabAt(`?tab=${old}`)).toBe(now);
	});

	it("open a current address as itself, and an unknown one on General", () => {
		expect(tabAt("?tab=pipeline")).toBe("pipeline");
		expect(tabAt("?tab=nonsense")).toBe("general");
		expect(tabAt("")).toBe("general");
	});

	it("leave no old address unrouted, and route none onto a tab that does not exist", () => {
		for (const target of Object.values(TAB_ALIASES)) expect(TAB_VALUES).toContain(target);
		for (const old of Object.keys(TAB_ALIASES)) expect(TAB_VALUES).not.toContain(old);
	});
});
