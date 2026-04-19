import type { Core } from '@strapi/strapi';

interface StatusChange {
  from: string | null;
  to: string;
  by: string;
  at: string;
}

export async function sendWebhook(
  strapi: Core.Strapi,
  issueDocumentId: string,
  change: StatusChange
) {
  try {
    // Get issue with project populated
    const issue = await strapi.documents('api::issue.issue').findOne({
      documentId: issueDocumentId,
      populate: ['project'],
    });

    if (!issue?.project) return;

    const project = issue.project as any;
    const webhookUrl = project.webhookUrl;
    const webhookSecret: string | null = project.webhookSecret ?? null;
    const webhookStatuses: string[] = project.webhookStatuses ?? [];

    if (!webhookUrl) return;
    if (webhookStatuses.length > 0 && !webhookStatuses.includes(change.to)) return;

    const payload = {
      event: 'issue:status_changed',
      issue: {
        documentId: issue.documentId,
        title: (issue as any).title,
        status: change.to,
      },
      change,
      project: {
        name: project.name,
        slug: project.slug,
      },
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (webhookSecret) {
      headers['Authorization'] = `Bearer ${webhookSecret}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    strapi.log.info(`Webhook sent to ${webhookUrl} for issue ${issueDocumentId} → ${change.to}`);
  } catch (err: any) {
    strapi.log.warn(`Webhook failed: ${err.message}`);
  }
}
