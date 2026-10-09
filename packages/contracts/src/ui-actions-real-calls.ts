// UI action calls as the chat model really made them (dev, 2026-10-09, read from
// conversation_messages.blocks: QA of dev.219 and dev.220, ISS-495). Each is one stored tool-call
// input, copied as it was sent, with what the contract must do with it. A scripted model sends the
// shape the contract was written for; these are the shapes the model sent. No personal data: the
// keys are the project's own ISS/REQ/FB records and a workflow's flow.

export interface RealUiCall {
	/** The wire name the model called. */
	name: string;
	/** The input exactly as the model sent it. */
	input: Record<string, unknown>;
	/** Where it was read: the shape the model was offered when it sent it. */
	offered:
		| "object-map-filter"
		| "list-filter"
		| "flat-highlight"
		| "target-highlight"
		| "other";
	/** `ok`, or the refusal by name: text the refusal must hold. */
	expect: "ok" | { refused: string };
}

const ALL_STATES = [
	"draft",
	"agreed",
	"in_delivery",
	"delivered",
	"accepted",
	"deferred",
	"dropped",
];

export const REAL_UI_CALLS: readonly RealUiCall[] = [
	// the map the model sent when the filter was offered as an object of optional fields: every
	// slot filled; what is wrong with each is refused by name, nothing else is
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: "x", state: ["draft"], waitingOn: "you" },
			mode: "merge",
			clear: [],
		},
		expect: { refused: "text must hold a word" },
	},
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: "/", state: ALL_STATES, waitingOn: "you" },
			mode: "replace",
			clear: [],
		},
		expect: { refused: "text must hold a word" },
	},
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: " ", state: ALL_STATES, waitingOn: "you" },
			mode: "replace",
			clear: [],
		},
		expect: { refused: "names every value" },
	},
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: ". .", state: ["draft"], waitingOn: "you" },
			mode: "merge",
			clear: ["state", "text"],
		},
		expect: { refused: "text must hold a word" },
	},
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: "wait", state: ALL_STATES, waitingOn: "you" },
			mode: "replace",
			clear: [],
		},
		expect: { refused: "state names every value" },
	},
	{
		name: "ui_requirements_filter",
		offered: "object-map-filter",
		input: {
			set: { text: "all", state: ["draft"], waitingOn: "you" },
			mode: "merge",
			clear: ["state", "text"],
		},
		expect: { refused: "a field cannot be both set and cleared" },
	},
	{
		name: "ui_feedback_filter",
		offered: "object-map-filter",
		input: {
			set: {
				kind: ["bug", "change_request", "question", "idea", "contract_change"],
				text: "},",
				phase: [
					"new",
					"triaged",
					"planned",
					"resolved",
					"reopened",
					"verified",
					"declined",
				],
				since: "30d",
				severity: "low",
				waitingOn: "running",
			},
			mode: "merge",
			clear: [],
		},
		expect: { refused: "text must hold a word" },
	},
	// the list the model sent once the filter was offered as {field, value} entries
	{
		name: "ui_requirements_filter",
		offered: "list-filter",
		input: { set: [{ field: "waitingOn", value: "you" }], mode: "replace" },
		expect: "ok",
	},
	{
		name: "ui_feedback_filter",
		offered: "list-filter",
		input: { set: [{ field: "waitingOn", value: "agent" }], mode: "merge" },
		expect: "ok",
	},
	{
		name: "ui_feedback_filter",
		offered: "list-filter",
		input: { set: [{ field: "waitingOn", value: "running" }], mode: "replace" },
		expect: "ok",
	},
	{
		name: "ui_workflows_filter",
		offered: "list-filter",
		input: { set: [{ field: "waitingOn", value: "agent" }], mode: "replace" },
		expect: "ok",
	},
	{
		name: "ui_requirements_filter",
		offered: "list-filter",
		input: { set: [{ field: "text", value: "chat" }], mode: "merge" },
		expect: "ok",
	},
	// highlight offered as one `target` object: every field filled, one of them a placeholder
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "ISS-493", step: "x", section: "plan" } },
		expect: "ok",
	},
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "ISS-495", step: "plan", section: "plan" } },
		expect: "ok",
	},
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "ISS-495", step: "noop", section: "plan" } },
		expect: "ok",
	},
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "REQ-41", step: "none", section: "criteria" } },
		expect: "ok",
	},
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "ISS-493", step: "unused", section: "criteria" } },
		expect: "ok",
	},
	{
		name: "ui_highlight",
		offered: "target-highlight",
		input: { target: { key: "chat-turn", step: "check", section: "question" } },
		expect: "ok",
	},
	// the flat shape of the first redesign: refused, by what it is
	{
		name: "ui_highlight",
		offered: "flat-highlight",
		input: { key: "x", step: "x", target: "section", section: "plan" },
		expect: { refused: "target" },
	},
	{
		name: "ui_open",
		offered: "other",
		input: { key: "ISS-493", kind: "issue" },
		expect: "ok",
	},
	{
		name: "ui_open",
		offered: "other",
		input: { key: "REQ-41", kind: "requirement" },
		expect: "ok",
	},
	{
		name: "ui_open",
		offered: "other",
		input: { key: "chat-turn", kind: "workflow" },
		expect: "ok",
	},
	{
		name: "ui_navigate",
		offered: "other",
		input: { route: "requirements" },
		expect: "ok",
	},
];
