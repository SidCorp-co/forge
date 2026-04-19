/**
 * Computes and caches project-level rolling stats from issue data.
 * Stats are stored on the project.rollingStats JSON field.
 */
export async function recomputeRollingStats(strapi: any, projectDocId: string): Promise<void> {
  try {
    const issues = await strapi.documents('api::issue.issue').findMany({
      filters: { project: { documentId: projectDocId } },
      fields: ['documentId', 'title', 'status', 'priority', 'category', 'updatedAt'],
      limit: -1,
    });

    const statusCounts: Record<string, number> = {};
    const priorityCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    const blockers: Array<{ documentId: string; title: string; status: string; priority: string }> = [];
    const stale: Array<{ documentId: string; title: string; status: string; daysSinceUpdate: number }> = [];
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    for (const issue of issues) {
      // Count by status
      const s = issue.status || 'unknown';
      statusCounts[s] = (statusCounts[s] || 0) + 1;

      // Count by priority
      const p = issue.priority || 'unknown';
      priorityCounts[p] = (priorityCounts[p] || 0) + 1;

      // Count by category
      const c = issue.category || 'unknown';
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;

      // Blockers: critical/high priority AND in_progress/approved/open
      if (
        (issue.priority === 'critical' || issue.priority === 'high') &&
        ['in_progress', 'approved', 'open'].includes(issue.status)
      ) {
        blockers.push({
          documentId: issue.documentId,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
        });
      }

      // Stale: >30 days since update, not closed/released/confirmed
      const age = now - new Date(issue.updatedAt).getTime();
      if (age > thirtyDays && !['closed', 'released', 'confirmed'].includes(issue.status)) {
        stale.push({
          documentId: issue.documentId,
          title: issue.title,
          status: issue.status,
          daysSinceUpdate: Math.floor(age / (24 * 60 * 60 * 1000)),
        });
      }
    }

    const stats = {
      totalIssues: issues.length,
      statusCounts,
      priorityCounts,
      categoryCounts,
      blockers: blockers.slice(0, 10),
      stale: stale.slice(0, 10),
      updatedAt: new Date().toISOString(),
    };

    // Save to project
    const project = await strapi.documents('api::project.project').findFirst({
      filters: { documentId: projectDocId },
      fields: ['id', 'documentId'],
    });
    if (project) {
      await strapi.documents('api::project.project').update({
        documentId: project.documentId,
        data: { rollingStats: stats },
      });
    }

    strapi.log.info(`[rolling-stats] Updated for project ${projectDocId}: ${issues.length} issues`);
  } catch (err: any) {
    strapi.log.warn(`[rolling-stats] Failed to recompute: ${err.message}`);
  }
}

/**
 * Check if rolling stats are fresh (updated within last 60 minutes).
 */
export function isRollingStatsFresh(stats: any): boolean {
  if (!stats?.updatedAt) return false;
  const age = Date.now() - new Date(stats.updatedAt).getTime();
  return age < 60 * 60 * 1000; // 60 minutes
}
