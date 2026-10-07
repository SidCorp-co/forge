// The sections of project settings, in the order a person comes to them: what the project is, who is
// on it, how its work is organised, how it ships, what it connects to, and the technical view.

export const SETTINGS_SECTIONS = ["general", "people", "work", "delivery", "connections", "advanced"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Every tab the page had before it was grouped, and where that content now stands, so a link
 *  written with the old `?tab=` still lands on it. */
export const LEGACY_TABS: Record<string, { section: SettingsSection; anchor?: string }> = {
	basics: { section: "general" },
	repo: { section: "delivery", anchor: "repository" },
	config: { section: "advanced", anchor: "documents" },
	runners: { section: "connections", anchor: "runners" },
	pipeline: { section: "delivery", anchor: "release-state" },
	labels: { section: "work", anchor: "labels" },
	modules: { section: "work", anchor: "modules" },
	members: { section: "people" },
	integrations: { section: "connections", anchor: "integrations" },
};

/** The link to a section, and a place inside it. */
export function settingsHref(slug: string, section: SettingsSection, anchor?: string): string {
	return `/projects/${encodeURIComponent(slug)}/settings${section === "general" ? "" : `?tab=${section}`}${anchor ? `#${anchor}` : ""}`;
}
