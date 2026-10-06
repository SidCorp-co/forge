import type { V1Document } from "../project-config/types";
import { schemaUrl } from "../project-config/document-edit";

export function projectTemplate(project: { id: string; slug: string; name: string }): V1Document {
	return {
		$schema: schemaUrl("project"),
		version: 1,
		project: { id: project.id, slug: project.slug, name: project.name },
		source: { type: "none" },
		workspace: { isolation: "worktree" },
		validation: { gate: { type: "none" } },
		environments: {},
		promotions: [],
		rollback: { strategy: "none" },
		execution: { plugin: { source: "SidCorp-co/forge-plugin", ref: "" } },
	};
}

export function policyTemplate(): V1Document {
	const state = { model: "opus", permissions: "driver" };
	return {
		$schema: schemaUrl("policy"),
		version: 1,
		qa: "self",
		intake: { mode: "manual" },
		permissions: { driver: { deny: [] } },
		states: { open: state, in_progress: state, needs_info: state },
	};
}

export function testingProfileTemplate(id: string): V1Document {
	return { $schema: schemaUrl("testing-profile"), version: 1, id, actors: {}, services: {}, limits: [] };
}

export function bindingTemplate(id: string): V1Document {
	return {
		$schema: schemaUrl("binding"),
		version: 1,
		id,
		role: "deploy",
		connection: "",
		target: { provider: "" },
	};
}
