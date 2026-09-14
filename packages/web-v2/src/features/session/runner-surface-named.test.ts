// ISS-1005 criterion 13 — the surface the assistant's persona sends people to must be one that
// still reaches a runner.
//
// The Forge UI chat moved off a paired box, and this issue ACCEPTED the reach that went rather
// than bridging it: editing a file, running a command and driving a pipeline all still need a
// session on a box. The persona's answer to a person who asks for one is to name
// `/projects/<slug>/agents`. That sentence is only true while that screen submits its turns to a
// runner — so what is asserted here is the CHAIN from the route to the HTTP call, hop by hop, and
// not that the persona contains a string or that some runner-backed verb exists somewhere.
//
// It lives under `features/session` and NOT under `features/conversations`, and that is the
// judgement `no-agent-sessions.test.ts` freezes rather than a filing preference: this file's whole
// assertion is that a run surface still reaches `agent-sessions`, and that scanner forbids that
// string anywhere it considers a conversation surface. A conversation surface's subject is a room;
// this one's subject is the session screen.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

const PERSONA = read("../core/src/assistant/conversation-send.ts");
const NAMED_ROUTE = "/projects/<slug>/agents";

describe("the runner surface the web assistant names", () => {
	it("is named in the persona, so a refusal carries a way forward", () => {
		expect(PERSONA).toContain(NAMED_ROUTE);
	});

	// cm:guard the chain is walked hop by hop because each hop is a place the surface could be re-pointed at the conversation store while every other hop still reads correctly. Asserting only the last hop — that `sessionApi.send` posts to `/agent-sessions/send` — passes on the day the screen stops calling it, which is the hole ISS-1005's review named (review F4).
	const CHAIN: ReadonlyArray<readonly [string, string, string]> = [
		[
			"the route the persona names renders the Agents screen",
			"src/app/(workspace)/projects/[slug]/agents/page.tsx",
			"@/features/agents/components/agents-screen",
		],
		[
			"the Agents screen lists sessions",
			"src/features/agents/components/agents-screen.tsx",
			"@/features/sessions/components/sessions-screen",
		],
		[
			"a row on that list opens the session route under it",
			"src/features/sessions/components/sessions-screen.tsx",
			"/agents/${row.id}",
		],
		[
			"that route renders the session screen",
			"src/app/(workspace)/projects/[slug]/agents/[sessionId]/page.tsx",
			"@/features/session/components/session-screen",
		],
		[
			"the session screen submits through the session feature's own send hook",
			"src/features/session/components/session-screen.tsx",
			"useSendMessage(sessionId)",
		],
		[
			"that hook calls the session API and not the conversation API",
			"src/features/session/hooks.ts",
			"sessionApi.send(",
		],
		[
			"the session API posts to the runner-backed endpoint",
			"src/features/session/api.ts",
			'"/agent-sessions/send"',
		],
	];

	for (const [what, file, needle] of CHAIN) {
		it(what, () => {
			expect(read(file), `${file} no longer carries "${needle}"`).toContain(needle);
		});
	}

	// cm:guard the negative half: the same files must reach the conversation store NOWHERE. A screen that added a conversation send beside the runner one would satisfy every `toContain` above while a person's turn went to whichever the handler actually picked.
	it("reaches the conversation store at no hop of that chain", () => {
		for (const [, file] of CHAIN) {
			expect(read(file), `${file} reaches the conversation store`).not.toMatch(
				/["'`]\/conversations/,
			);
		}
	});
});
