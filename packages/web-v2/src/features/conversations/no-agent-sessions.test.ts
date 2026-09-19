
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONVERSATION_SURFACES = [
	"src/features/conversations",
	"src/app/(workspace)/conversations",
	"src/app/(workspace)/layout.tsx",
];

const RUN_STORE = [/agent_sessions/, /agent-sessions/, /["'`]agent-session["'`]/];

const files = (path: string): string[] => {
	const full = join(process.cwd(), path);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(full);
	} catch {
		return [];
	}
	if (!stat.isDirectory()) return [full];
	return readdirSync(full).flatMap((entry) => files(join(path, entry)));
};

const code = (body: string): string =>
	body
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

describe("no conversation surface reads agent_sessions", () => {
	const scanned = CONVERSATION_SURFACES.flatMap(files).filter(
		(f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith("no-agent-sessions.test.ts"),
	);

	it("scans a set that is not empty, so a rename cannot pass this by scanning nothing", () => {
		expect(scanned.length).toBeGreaterThan(10);
	});

	for (const file of scanned) {
		const rel = file.slice(file.indexOf("src/"));
		it(`${rel} reaches no run store`, () => {
			const body = code(readFileSync(file, "utf8"));
			const hit = RUN_STORE.find((pattern) => pattern.test(body));
			expect(hit, `${rel} reads the run store via ${hit?.source}`).toBeUndefined();
		});
	}
});
