
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

const PERSONA = read("../core/src/assistant/prompt/door-web.ts");
const NAMED_ROUTE = "/projects/{projectSlug}/agents";

describe("the runner surface the web assistant names", () => {
	it("is named in the persona, so a refusal carries a way forward", () => {
		expect(PERSONA).toContain(NAMED_ROUTE);
	});

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
			`/agents/$${"{row.id}"}`,
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

	it("reaches the conversation store at no hop of that chain", () => {
		for (const [, file] of CHAIN) {
			expect(read(file), `${file} reaches the conversation store`).not.toMatch(
				/["'`]\/conversations/,
			);
		}
	});
});
