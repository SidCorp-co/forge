import type { ForgeTool } from './tools';

const getConfig = (projectOverride?: string) => {
  const token = process.env.SENTRY_ACCESS_TOKEN;
  const host = process.env.SENTRY_HOST;
  const org = process.env.SENTRY_ORG;
  const project = projectOverride || process.env.SENTRY_PROJECT || '';
  if (!token || !host || !org) return null;
  return { token, host, org, project, baseUrl: `https://${host}/api/0` };
};

type SentryConfig = NonNullable<ReturnType<typeof getConfig>>;

async function sentryFetch(path: string, config: SentryConfig, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sentry API error (${res.status}): ${text}`);
  }
  return res.json();
}

export const forgeSentry: ForgeTool = {
  name: 'forge_sentry',
  description: 'Sentry error tracking: list_projects, list_issues, get_issue, get_event, list_events, resolve, ignore, stats.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_projects', 'list_issues', 'get_issue', 'get_event', 'list_events', 'resolve', 'ignore', 'stats'] },
      query: { type: 'string' },
      issueId: { type: 'string' },
      cursor: { type: 'string' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const config = getConfig(ctx.sentryProject);
    if (!config) {
      return 'Error: Sentry not configured. Set SENTRY_ACCESS_TOKEN, SENTRY_HOST, and SENTRY_ORG env vars.';
    }

    const action = input.action as string;
    const { org, project } = config;

    if (action === 'list_projects') {
      const projects = await sentryFetch(`/organizations/${org}/projects/`, config);
      return JSON.stringify(
        projects.map((p: any) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          platform: p.platform,
        })),
      );
    }

    if (action === 'list_issues') {
      const query = (input.query as string) || 'is:unresolved';
      const params = new URLSearchParams({ query });
      const path = project
        ? `/projects/${org}/${project}/issues/?${params}`
        : `/organizations/${org}/issues/?${params}`;
      const issues = await sentryFetch(path, config);
      return JSON.stringify(
        issues.map((i: any) => ({
          id: i.id,
          title: i.title,
          culprit: i.culprit,
          level: i.level,
          status: i.status,
          count: i.count,
          firstSeen: i.firstSeen,
          lastSeen: i.lastSeen,
          shortId: i.shortId,
          project: i.project?.slug,
        })),
      );
    }

    if (action === 'get_issue') {
      const id = input.issueId as string;
      if (!id) return 'Error: issueId required for get_issue action';
      const [issue, latestEvent] = await Promise.all([
        sentryFetch(`/issues/${id}/`, config),
        sentryFetch(`/issues/${id}/events/latest/`, config).catch(() => null),
      ]);

      const result: any = {
        id: issue.id,
        title: issue.title,
        culprit: issue.culprit,
        level: issue.level,
        status: issue.status,
        count: issue.count,
        userCount: issue.userCount,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        metadata: issue.metadata,
      };

      if (latestEvent?.entries) {
        const exception = latestEvent.entries.find((e: any) => e.type === 'exception');
        if (exception?.data?.values) {
          result.stackTrace = exception.data.values.map((v: any) => ({
            type: v.type,
            value: v.value,
            frames: v.stacktrace?.frames?.slice(-10).map((f: any) => ({
              filename: f.filename,
              function: f.function,
              lineNo: f.lineNo,
              colNo: f.colNo,
              context: f.context,
            })),
          }));
        }
      }

      return JSON.stringify(result);
    }

    if (action === 'get_event') {
      const id = input.issueId as string;
      if (!id) return 'Error: issueId required for get_event action';
      const event = await sentryFetch(`/issues/${id}/events/latest/`, config);

      // Extract only the useful parts to keep response small
      const result: any = {
        eventID: event.eventID,
        title: event.title,
        message: event.message,
        dateCreated: event.dateCreated,
        tags: event.tags?.filter((t: any) =>
          ['transaction', 'url', 'browser', 'environment', 'level', 'server_name'].includes(t.key),
        ),
      };

      // Extract stack trace from exception entry
      if (event.entries) {
        const exception = event.entries.find((e: any) => e.type === 'exception');
        if (exception?.data?.values) {
          result.stackTrace = exception.data.values.map((v: any) => ({
            type: v.type,
            value: v.value,
            frames: v.stacktrace?.frames?.slice(-10).map((f: any) => ({
              filename: f.filename,
              function: f.function,
              lineNo: f.lineNo,
              colNo: f.colNo,
              context: f.context,
            })),
          }));
        }

        // Extract request info if present
        const request = event.entries.find((e: any) => e.type === 'request');
        if (request?.data) {
          result.request = {
            url: request.data.url,
            method: request.data.method,
            query: request.data.query,
            headers: request.data.headers,
          };
        }

        // Extract last 10 breadcrumbs for debugging context
        const breadcrumbs = event.entries.find((e: any) => e.type === 'breadcrumbs');
        if (breadcrumbs?.data?.values?.length) {
          result.breadcrumbs = breadcrumbs.data.values.slice(-10).map((b: any) => ({
            type: b.type,
            category: b.category,
            message: b.message,
            level: b.level,
            timestamp: b.timestamp,
          }));
        }
      }

      // Extract key runtime context (not the full blob)
      if (event.contexts) {
        const c: any = {};
        if (event.contexts.runtime) c.runtime = { name: event.contexts.runtime.name, version: event.contexts.runtime.version };
        if (event.contexts.os) c.os = { name: event.contexts.os.name, version: event.contexts.os.version };
        if (event.contexts.browser) c.browser = { name: event.contexts.browser.name, version: event.contexts.browser.version };
        if (Object.keys(c).length) result.contexts = c;
      }

      return JSON.stringify(result);
    }

    if (action === 'list_events') {
      const id = input.issueId as string;
      if (!id) return 'Error: issueId required for list_events action';
      const params = new URLSearchParams();
      if (input.cursor) params.set('cursor', input.cursor as string);
      const res = await fetch(`${config.baseUrl}/issues/${id}/events/?${params}`, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Sentry API error (${res.status}): ${text}`);
      }
      const events: any[] = await res.json() as any[];
      const link = res.headers.get('link') || '';
      const nextMatch = link.match(/results="true".*?cursor="([^"]+)"/);
      const result: any = {
        events: events.map((e: any) => ({
          eventID: e.eventID,
          title: e.title,
          message: e.message || e.metadata?.value,
          dateCreated: e.dateCreated,
          tags: e.tags?.filter((t: any) => ['transaction', 'url', 'browser'].includes(t.key)),
        })),
      };
      if (nextMatch) result.nextCursor = nextMatch[1];
      return JSON.stringify(result);
    }

    if (action === 'resolve') {
      const id = input.issueId as string;
      if (!id) return 'Error: issueId required for resolve action';
      const result = await sentryFetch(`/issues/${id}/`, config, {
        method: 'PUT',
        body: JSON.stringify({ status: 'resolved' }),
      });
      return JSON.stringify({ id, status: result.status, message: 'Issue resolved' });
    }

    if (action === 'ignore') {
      const id = input.issueId as string;
      if (!id) return 'Error: issueId required for ignore action';
      const result = await sentryFetch(`/issues/${id}/`, config, {
        method: 'PUT',
        body: JSON.stringify({ status: 'ignored' }),
      });
      return JSON.stringify({ id, status: result.status, message: 'Issue ignored' });
    }

    if (action === 'stats') {
      const path = project
        ? `/projects/${org}/${project}/stats/`
        : `/organizations/${org}/stats/`;
      const stats = await sentryFetch(path, config);
      return JSON.stringify(stats);
    }

    return `Unknown action: ${action}`;
  },
};
