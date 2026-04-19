export interface AgentDefinition {
  documentId: string;
  name: string;
  type: string;
  description: string | null;
  promptTemplate: string;
  reindexPromptTemplate: string | null;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: string;
  approvalMode: string;
  maxProposals: number;
  excludeCategories: string[];
}

export interface AgentConfig {
  enabled: boolean;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: string;
  approvalMode: string;
  maxProposals: number;
  excludeCategories: string[];
  promptTemplate?: string | null;
  reindexPromptTemplate?: string | null;
  definition?: AgentDefinition | null;
}

const FOCUS_AREA_DESCRIPTIONS: Record<string, string> = {
  "feature-gaps": "Feature Gaps — Features users would expect but have no issue tracking them",
  "journey-completeness": "Journey Completeness — If feature X exists, features Y and Z are implied (e.g. if login exists, password reset should too)",
  "polish": "Polish & QoL — Empty states, loading states, error handling, onboarding flows, helpful defaults",
  "accessibility": "Accessibility — Obvious gaps from code structure and descriptions (keyboard nav, screen reader, contrast)",
  "ux-improvements": "UX Improvements — Friction points, confusing flows, missing feedback, inconsistent patterns",
};

/**
 * Interpolate template variables in a prompt template string.
 * Supported variables: {{focusAreas}}, {{maxProposals}}, {{excludeCategories}},
 * {{customInstructions}}, {{approvalMode}}, {{projectSlug}}
 */
function interpolate(template: string, config: AgentConfig, projectSlug: string): string {
  const focusLines = (config.focusAreas || [])
    .map((area) => FOCUS_AREA_DESCRIPTIONS[area] || area)
    .map((desc) => `- ${desc}`)
    .join("\n");

  const excludeSection = (config.excludeCategories || []).length > 0
    ? `\n\n## Excluded Categories\nDo NOT propose issues in these categories: ${config.excludeCategories.join(", ")}`
    : "";

  const customSection = config.customInstructions
    ? `\n\n## Custom Instructions\n${config.customInstructions}`
    : "";

  const approvalText = config.approvalMode === "preview"
    ? "Your proposals will be reviewed by a human before being actioned."
    : "Your proposals will be created directly as issues.";

  return template
    .replace(/\{\{focusAreas\}\}/g, focusLines)
    .replace(/\{\{maxProposals\}\}/g, String(config.maxProposals ?? 10))
    .replace(/\{\{excludeCategories\}\}/g, excludeSection)
    .replace(/\{\{customInstructions\}\}/g, customSection)
    .replace(/\{\{approvalMode\}\}/g, approvalText)
    .replace(/\{\{projectSlug\}\}/g, projectSlug);
}

/**
 * Build the main agent review prompt from definition template + agent config overrides.
 */
export function buildAgentPrompt(config: AgentConfig, projectSlug: string): string {
  const template = config.promptTemplate || config.definition?.promptTemplate;
  if (!template) {
    throw new Error(`Agent has no prompt template (checked agent and definition)`);
  }
  return interpolate(template, config, projectSlug);
}

/**
 * Build the reindex/setup prompt from agent override or definition template.
 */
export function buildAgentReindexPrompt(config: AgentConfig, projectSlug: string): string {
  const template = config.reindexPromptTemplate || config.definition?.reindexPromptTemplate;
  if (!template) {
    throw new Error(`Agent has no reindex prompt template (checked agent and definition)`);
  }
  return interpolate(template, config, projectSlug);
}
