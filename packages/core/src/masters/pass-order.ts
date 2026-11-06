// The fixed words a master's pass is typed with (`owed.ts:masterWork`): the order of a dispatching
// pass, the order of a direct one, and the room door a master posts its own results through. Each
// names the served guide that holds its method, never restates it (REQ-23 BC-2).

import { guideCall } from '../guides/index.js';

const method = (slug: 'dispatch') => `\`${guideCall(slug)}\``;

/** The room door a master posts its own results through, named on every pass (ISS-943). */
const ROOM_POST = ` A result for a room your project binds you post yourself: \`forge-runner api projects/<projectId>/support/master-posts -X POST\` with \`{ text, rid?, thread? }\`, as ${method('dispatch')} (Telling a room what came of it) says.`;

/** The dispatch pass names the served guide, never a skill a plugin on the pane could answer to (ISS-304). */
export const NUDGE = `Pass. Run the wave by ${method('dispatch')}.${ROOM_POST}`;

/**
 * How a master on a project that runs fast works (`@forge/contracts/master-mode`): it builds the
 * batch and records afterwards, so its pass names no dispatch. The goal is said, and the kernel
 * limits with it, since they are what still refuses it; the order of the acts is the guide's.
 */
export const DIRECT_ORDER = ` This project's master works direct (fast delivery on, not strict): build the batch yourself, in this session or through general-purpose subagents on disjoint files. Dispatch no runner role, print no brief, and wait on no plan approval, design record or judge before landing. Land through the project's own landing route once the batch builds (typecheck included) and the tests related to its changed files pass (an MR where the project lands by change request, a push to the base branch only where it lands by push); the whole suite, lint and CI run after the push, and a red there is fixed forward. A project rule that asks for more before landing still holds. The kernel still refuses: a move into \`in_progress\` or \`awaiting_release\` by anyone but the issue's holder (its lease, as the issue-flow guide's Take it says), a move off a legal edge or without its reason, \`awaiting_release\` without a recorded merge (\`forge-runner api issues/<id>/merge -X POST\` at the landing sha), and a close by anything but a release. A criterion's verdict is recorded only once you have checked it live, after landing. ${method('dispatch')} (Direct mode) is the method.${ROOM_POST}`;

export const DIRECT_NUDGE = `Pass.${DIRECT_ORDER}`;
