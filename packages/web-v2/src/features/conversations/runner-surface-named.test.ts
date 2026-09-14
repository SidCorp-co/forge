// ISS-1005 criterion 13 — the surface the assistant's persona sends people to must be one that
// still reaches a runner.
//
// The Forge UI chat moved off a paired box, and this issue ACCEPTED the reach that went rather
// than bridging it: editing a file, running a command and driving a pipeline all still need a
// session on a box. The persona's answer to a person who asks for one is to name
// `/projects/<slug>/agents`. That sentence is only true while that screen submits its turns to a
// runner — so the assertion is on the SEND path and not on the persona string, which would keep
// passing on the day the screen it names moved onto the conversation store too.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

const PERSONA = read("../core/src/assistant/conversation-send.ts");
const SESSION_API = read("src/features/session/api.ts");
const NAMED_ROUTE = "/projects/<slug>/agents";

describe("the runner surface the web assistant names", () => {
	it("is named in the persona, so a refusal carries a way forward", () => {
		expect(PERSONA).toContain(NAMED_ROUTE);
	});

	it("exists as a route in this app", () => {
		expect(() => read("src/app/(workspace)/projects/[slug]/agents/page.tsx")).not.toThrow();
	});

	// cm:guard THIS is the assertion the other two only support: a screen whose reads stayed on `agent_sessions` while its submit moved onto `/conversations` would pass both of them and make the persona's sentence false. The send verb is what decides whether a turn reaches a box.
	it("submits its turns to a runner-backed endpoint and not to the conversation store", () => {
		const send = SESSION_API.slice(SESSION_API.indexOf("send: ("));
		const body = send.slice(0, send.indexOf("},"));
		expect(body).toContain("/agent-sessions/send");
		expect(body).not.toContain("/conversations");
	});
});
