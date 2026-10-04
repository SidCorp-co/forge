// cm:why an agent-facing reference names a public guide, never one project's design, which
// another project's agent cannot read (ISS-90)
export const GUIDE_SLUGS = [
  'project-settings-and-test-credentials',
  'issue-dependencies',
  'memory-and-knowledge',
  'deploy-safety',
  'google-sheets',
  'what-is-an-issue',
  'writing-an-issue',
  'pipeline-and-issue-lifecycle',
  'attachments-and-uploads',
  'agent-setup',
  'update-pipeline-reconcile',
  'module-taxonomy-migration',
  'conformance-and-verify',
  'answering-as-the-assistant',
  'records-and-comments',
  'ecosystem-inbox',
  'workflow-design',
  'workflow-templates',
  'requirement-lifecycle',
  'suggestions',
  'feedback-triage',
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export const guideRef = (slug: GuideSlug): string => `forge_guide get ${slug}`;
