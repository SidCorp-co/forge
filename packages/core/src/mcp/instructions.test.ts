import { describe, expect, it } from "vitest";

import { FORGE_MCP_INSTRUCTIONS } from "./instructions.js";

// The MCP `instructions` string is auto-loaded into every connected session, so
// it's load-bearing orientation — pin the key pointers so a careless edit can't
// silently drop them. (Mirrors how system.test.ts pins the CHAT_NUDGE.)
describe("FORGE_MCP_INSTRUCTIONS", () => {
	it("orients the session and points at the core tools/prompt", () => {
		expect(FORGE_MCP_INSTRUCTIONS).toContain("Forge-managed project");
		// recall-first memory contract
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge_memory_search");
		expect(FORGE_MCP_INSTRUCTIONS).toContain("NOT auto-loaded");
		// codebase orientation — ISS-567 removed the local file read path;
		// orientation now points at the forge_knowledge MCP tool.
		expect(FORGE_MCP_INSTRUCTIONS).not.toContain("get_knowledge");
		expect(FORGE_MCP_INSTRUCTIONS).not.toContain(".forge/knowledge.json");
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge_knowledge");
		// project settings discoverability — test creds/URLs live on
		// forge_projects.get → previewDeploy, NOT in forge_config (recurring
		// confusion; feedback cd8ad9f9 / the capability-map issue).
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge_projects.get");
		expect(FORGE_MCP_INSTRUCTIONS).toContain("previewDeploy");
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge_config");
		// project-management tools
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge_issues");
		// skill-authoring meta prompt
		expect(FORGE_MCP_INSTRUCTIONS).toContain("forge-skills");
		// projectId is delegated to the repo CLAUDE.md, not baked here (stays
		// cache-shareable across projects)
		expect(FORGE_MCP_INSTRUCTIONS).toContain("CLAUDE.md");
	});

	it("stays tight — it costs context tokens on every connected session", () => {
		// Guardrail, not a hard spec: if this grows a lot, reconsider whether the
		// content belongs in a forge-* MCP prompt instead of always-on instructions.
		// (ISS-541 trigger-framed the deps/draft affordances inline → ~1200;
		// the project-settings pointer added ~260 more — the capability-map issue
		// will move the on-demand detail behind a fetchable guide index.)
		expect(FORGE_MCP_INSTRUCTIONS.length).toBeLessThan(1450);
	});
});
