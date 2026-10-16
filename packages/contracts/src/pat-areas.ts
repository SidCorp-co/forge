// The token grant menu, arranged for a person choosing from it: every key the menu offers (a route
// group `<resource>:<level>` from core's `PAT_PERMISSION_NAMES`, or a named act from
// `TOKEN_EXPLICIT_PERMISSIONS`) sits in exactly one area, and core's `pat-areas.test.ts` refuses a
// menu key no area holds or an area key the menu does not offer. The keys a grant sends are the
// menu's own; an area only decides where a key is shown.

export const PAT_GRANT_AREAS = [
	{ id: "issues", keys: ["issues:read", "issues:write", "comments.moderate"] },
	{
		id: "pipeline",
		keys: [
			"pipeline:read",
			"pipeline:write",
			"runners:read",
			"runners:write",
			"schedules:read",
			"schedules:write",
			"agent-reports:read",
			"agent-reports:write",
		],
	},
	{
		id: "knowledge",
		keys: ["knowledge:read", "knowledge:write", "skills:read", "skills:write"],
	},
	{
		id: "project",
		keys: [
			"projects:read",
			"projects:write",
			"questions:read",
			"questions:write",
			"questionnaires.answer",
			"onboarding.request",
			"charter.write",
			"commitments.write",
			"shares.public",
		],
	},
	{
		id: "design",
		keys: [
			"requirements.approve",
			"workflow-designs.approve",
			"workflow-observations.write",
			"mockups.approve",
			"previews.approve",
			"patterns.approve",
			"contracts.approve",
			"plans.approve",
		],
	},
	{
		id: "feedback",
		keys: ["feedback.approve", "feedback.redact", "suggestions.approve"],
	},
	{ id: "releases", keys: ["releases.approve"] },
	{ id: "assistant", keys: ["assistant:read", "assistant:write", "assistant.exec"] },
	{
		id: "account",
		keys: [
			"account:read",
			"account:write",
			"orgs:read",
			"orgs:write",
			"ecosystems:read",
			"ecosystems:write",
			"devices:read",
			"devices:write",
			"admin:read",
			"admin:write",
		],
	},
] as const;

export type PatGrantAreaId = (typeof PAT_GRANT_AREAS)[number]["id"];
export type PatGrantKey = (typeof PAT_GRANT_AREAS)[number]["keys"][number];

/**
 * The three ready grants a person picks before choosing key by key. `read` and `readWrite` name route
 * groups only: a named act (an approval, a moderation) is held only where a person ticks it.
 */
export const PAT_GRANT_PRESETS = ["read", "readWrite", "full"] as const;
export type PatGrantPreset = (typeof PAT_GRANT_PRESETS)[number];
