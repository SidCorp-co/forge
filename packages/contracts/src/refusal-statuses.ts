// Every module's non-422 refusal codes in one table, read by both doors of core.
import { AGENT_SESSION_REFUSAL_STATUSES } from "./agent-sessions.js";
import { ATTACHMENT_REFUSAL_STATUSES } from "./attachments.js";
import { AUTH_REFUSAL_STATUSES } from "./auth.js";
import { CHAT_PROPOSAL_REFUSAL_STATUSES } from "./chat-proposals.js";
import { CHECK_RUN_REFUSAL_STATUSES } from "./check-runs.js";
import { CHECKLIST_REFUSAL_STATUSES } from "./checklists.js";
import { CONVERSATION_REFUSAL_STATUSES } from "./conversations.js";
import { DEVICE_REFUSAL_STATUSES } from "./devices.js";
import { ECOSYSTEM_REFUSAL_STATUSES } from "./ecosystem.js";
import { FAST_LANE_REFUSAL_STATUSES } from "./fast-lane.js";
import { ISSUE_TRANSITION_REFUSAL_STATUSES } from "./issue-machine.js";
import {
	ISSUE_CREATE_REFUSAL_STATUSES,
	ISSUE_TAKE_REFUSAL_STATUSES,
	ISSUE_UPDATE_REFUSAL_STATUSES,
} from "./issues.js";
import { MEMORY_REFUSAL_STATUSES } from "./memory.js";
import { PATTERN_REFUSAL_STATUSES } from "./patterns.js";
import { PIPELINE_REFUSAL_STATUSES } from "./pipeline.js";
import { PREVIEW_REFUSAL_STATUSES } from "./preview.js";
import { PRODUCT_STATE_REFUSAL_STATUSES } from "./product-state.js";
import { PROJECT_CONFIG_REFUSAL_STATUSES } from "./project-config.js";
import { PROJECT_REFUSAL_STATUSES } from "./projects.js";
import { QUESTION_REFUSAL_STATUSES } from "./questions.js";
import type { RefusalStatus } from "./refusal.js";
import { RELEASE_REFUSAL_STATUSES } from "./releases.js";
import { EXECUTION_REFUSAL_STATUSES } from "./report-executions.js";
import { REPORT_REFUSAL_STATUSES } from "./report-queries.js";
import { REQUIREMENT_REFUSAL_STATUSES } from "./requirements.js";
import { SHARE_REFUSAL_STATUSES } from "./shares.js";
import { STATE_MACHINE_REFUSAL_STATUSES } from "./state-machine.js";
import { STATUS_REPORT_REFUSAL_STATUSES } from "./status-reports.js";
import { SUGGESTION_REFUSAL_STATUSES } from "./suggestions.js";
import { WHATS_NEW_REFUSAL_STATUSES } from "./whats-new.js";
import { DESIGN_REFUSAL_STATUSES } from "./workflows.js";

/** The request-shape answer core builds from a failed validator. */
const REQUEST_REFUSAL_STATUSES = { BAD_REQUEST: 400 } as const;

const DECLARED: ReadonlyArray<
	Readonly<Record<string, Exclude<RefusalStatus, 422>>>
> = [
	REQUEST_REFUSAL_STATUSES,
	AGENT_SESSION_REFUSAL_STATUSES,
	ATTACHMENT_REFUSAL_STATUSES,
	AUTH_REFUSAL_STATUSES,
	CHAT_PROPOSAL_REFUSAL_STATUSES,
	CHECK_RUN_REFUSAL_STATUSES,
	CHECKLIST_REFUSAL_STATUSES,
	CONVERSATION_REFUSAL_STATUSES,
	DEVICE_REFUSAL_STATUSES,
	ECOSYSTEM_REFUSAL_STATUSES,
	FAST_LANE_REFUSAL_STATUSES,
	ISSUE_TRANSITION_REFUSAL_STATUSES,
	ISSUE_CREATE_REFUSAL_STATUSES,
	ISSUE_TAKE_REFUSAL_STATUSES,
	ISSUE_UPDATE_REFUSAL_STATUSES,
	MEMORY_REFUSAL_STATUSES,
	PATTERN_REFUSAL_STATUSES,
	PIPELINE_REFUSAL_STATUSES,
	PREVIEW_REFUSAL_STATUSES,
	PRODUCT_STATE_REFUSAL_STATUSES,
	PROJECT_CONFIG_REFUSAL_STATUSES,
	PROJECT_REFUSAL_STATUSES,
	QUESTION_REFUSAL_STATUSES,
	RELEASE_REFUSAL_STATUSES,
	EXECUTION_REFUSAL_STATUSES,
	REPORT_REFUSAL_STATUSES,
	REQUIREMENT_REFUSAL_STATUSES,
	SHARE_REFUSAL_STATUSES,
	STATE_MACHINE_REFUSAL_STATUSES,
	STATUS_REPORT_REFUSAL_STATUSES,
	SUGGESTION_REFUSAL_STATUSES,
	DESIGN_REFUSAL_STATUSES,
	WHATS_NEW_REFUSAL_STATUSES,
];

function collect(): ReadonlyMap<string, Exclude<RefusalStatus, 422>> {
	const out = new Map<string, Exclude<RefusalStatus, 422>>();
	for (const table of DECLARED) {
		for (const [code, status] of Object.entries(table)) {
			const held = out.get(code);
			if (held !== undefined && held !== status) {
				throw new Error(
					`refusal code ${code} is declared ${held} in one module and ${status} in another`,
				);
			}
			out.set(code, status);
		}
	}
	return out;
}

const REFUSAL_STATUS = collect();

/** The status a refusal code answers: as declared, 403 for any `_FORBIDDEN` code, else 422. */
export function refusalStatusOf(code: string): RefusalStatus {
	return REFUSAL_STATUS.get(code) ?? (code.endsWith("_FORBIDDEN") ? 403 : 422);
}
