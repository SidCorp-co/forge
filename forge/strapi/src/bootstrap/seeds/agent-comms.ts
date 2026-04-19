const ISSUE_UID = 'api::issue.issue' as any;
const PROJECT_UID = 'api::project.project' as any;

/**
 * Seed the standing "Agent Comms Channel" issue in the CEO project.
 * This is the Tier 2 cross-project signal board where project agents post FYI comments.
 * Also ensures the CEO project has 'escalation' in its categories for Tier 1 filtering.
 */
export async function seedAgentComms(strapi: any) {
  // Find the CEO project (crossProjectAccess: true)
  const ceoProject = await strapi.documents(PROJECT_UID).findFirst({
    filters: { crossProjectAccess: { $eq: true } },
    fields: ['documentId', 'agentConfig'],
  });

  if (!ceoProject) {
    strapi.log.debug('[seed] No CEO project found (crossProjectAccess: true) — skipping Agent Comms seed');
    return;
  }

  // Ensure 'escalation' category exists in CEO project config
  const config = ceoProject.agentConfig || {};
  const categories: string[] = config.categories || [];
  if (!categories.includes('escalation')) {
    categories.push('escalation');
    await strapi.documents(PROJECT_UID).update({
      documentId: ceoProject.documentId,
      data: { agentConfig: { ...config, categories } },
    });
    strapi.log.info('[seed] Added "escalation" category to CEO project');
  }

  // Check if Agent Comms issue already exists
  const existing = await strapi.documents(ISSUE_UID).findMany({
    filters: {
      project: { documentId: { $eq: ceoProject.documentId } },
      title: { $containsi: 'Agent Comms' },
    },
    limit: 1,
  });

  if (existing.length > 0) return;

  // Create the standing Agent Comms issue
  await strapi.documents(ISSUE_UID).create({
    data: {
      title: 'Agent Comms Channel',
      description: [
        '## Standing Message Board',
        '',
        'This is the **Agent Comms Channel** — a standing issue used as a cross-project message board for project agents.',
        '',
        '### Usage',
        '',
        'Project agents post comments here for quick FYI, status updates, and heads-ups that don\'t need a full escalation issue.',
        '',
        '**Comment format:** `[<project-slug>] <message>`',
        '',
        '### Examples',
        '- `[forge-agents] Pipeline upgrade deployed — all projects now support auto-clarify`',
        '- `[sid-desk] Switching to PostgreSQL next week — expect migration downtime`',
        '- `[hrm] New API endpoint /api/leave-balances live — available for integration`',
        '',
        '### Rules',
        '- Keep messages concise (1-3 sentences)',
        '- If a signal becomes a blocker, escalate to a Tier 1 escalation issue instead',
        '- Use category `escalation` for full escalation issues; this channel is for lightweight signals only',
      ].join('\n'),
      status: 'open',
      priority: 'none',
      category: 'process',
      project: { documentId: ceoProject.documentId },
    },
  });

  strapi.log.info('[seed] Created "Agent Comms Channel" issue in CEO project');
}
