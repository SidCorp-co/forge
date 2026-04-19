import { broadcast } from '../services/websocket';

const NOTIFICATION_UID = 'api::notification.notification' as const;

function fireNotification(
  strapi: any,
  data: {
    type: 'issue_status_changed' | 'comment_added' | 'agent_completed';
    title: string;
    body?: string;
    issueDocumentId?: string;
    agentSessionDocumentId?: string;
    project?: string;
  },
) {
  setImmediate(() => {
    strapi
      .documents(NOTIFICATION_UID)
      .create({ data })
      .then((result: any) =>
        broadcast('notification:created', {
          documentId: result.documentId,
          type: data.type,
          title: data.title,
        }),
      )
      .catch((err: any) => strapi.log.error(`Notification creation failed: ${err}`));
  });
}

function snapshotBefore(event: any, key: string, record: any) {
  if (!event.state) event.state = {};
  event.state[key] = record;
}

export function subscribeNotificationLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: ['api::issue.issue'],

    async beforeUpdate(event: any) {
      try {
        const id = event.params?.where?.id;
        if (!id) return;
        const current = await strapi.db.query('api::issue.issue').findOne({
          where: { id },
          select: ['id', 'documentId', 'title', 'status'],
          populate: ['project'],
        });
        snapshotBefore(event, 'notifPrevious', current);
      } catch { /* don't block the update */ }
    },

    async afterUpdate(event: any) {
      const { result } = event;
      const previous = event.state?.notifPrevious;
      if (!previous || !result.status || result.status === previous.status) return;

      fireNotification(strapi, {
        type: 'issue_status_changed',
        title: `ISS-${result.id}: ${result.title}`,
        body: `Status changed from ${previous.status} to ${result.status}`,
        issueDocumentId: result.documentId,
        project: previous.project?.documentId,
      });
    },
  });

  strapi.db.lifecycles.subscribe({
    models: ['api::comment.comment'],

    async afterCreate(event: any) {
      const { result } = event;
      const full = await strapi.db.query('api::comment.comment').findOne({
        where: { id: result.id },
        populate: ['issue', 'issue.project'],
      });
      if (!full?.issue) return;

      fireNotification(strapi, {
        type: 'comment_added',
        title: `New comment on ISS-${full.issue.id}: ${full.issue.title}`,
        body: (full.body || '').slice(0, 200),
        issueDocumentId: full.issue.documentId,
        project: full.issue.project?.documentId,
      });
    },
  });

  strapi.db.lifecycles.subscribe({
    models: ['api::agent-session.agent-session'],

    async beforeUpdate(event: any) {
      try {
        const id = event.params?.where?.id;
        if (!id) return;
        const current = await strapi.db.query('api::agent-session.agent-session').findOne({
          where: { id },
          select: ['id', 'documentId', 'title', 'status'],
          populate: ['project'],
        });
        snapshotBefore(event, 'notifPrevSession', current);

        // Auto-set startedAt in metadata when transitioning to 'running'
        const newStatus = event.params?.data?.status;
        if (newStatus === 'running' && current?.status !== 'running') {
          const meta = event.params.data.metadata || {};
          if (!meta.startedAt) {
            event.params.data.metadata = { ...meta, startedAt: new Date().toISOString() };
          }
        }
      } catch { /* don't block the update */ }
    },

    async afterUpdate(event: any) {
      const { result } = event;
      const previous = event.state?.notifPrevSession;
      if (!previous || result.status === previous.status) return;
      if (result.status !== 'completed' && result.status !== 'failed') return;

      const verb = result.status === 'completed' ? 'completed' : 'failed';
      fireNotification(strapi, {
        type: 'agent_completed',
        title: `Agent session ${verb}: ${result.title || 'Untitled'}`,
        agentSessionDocumentId: result.documentId,
        project: previous.project?.documentId,
      });
    },
  });
}
