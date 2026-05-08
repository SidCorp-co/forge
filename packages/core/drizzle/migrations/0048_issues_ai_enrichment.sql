-- ISS-59 — restore AI enrichment fields the Hono port dropped. All nullable;
-- written by the skill pipeline (forge-clarify / forge-plan) via the MCP
-- forge_issues.update tool. Read-only from REST clients in v1.
ALTER TABLE issues ADD COLUMN ai_summary text;
ALTER TABLE issues ADD COLUMN ai_suggested_solution text;
ALTER TABLE issues ADD COLUMN ai_acceptance_criteria jsonb;
ALTER TABLE issues ADD COLUMN ai_confidence real;
ALTER TABLE issues ADD CONSTRAINT issues_ai_confidence_chk
  CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1));
