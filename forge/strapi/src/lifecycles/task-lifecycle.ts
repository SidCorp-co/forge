import { broadcast } from '../services/websocket';
import { checkIssueResolution } from '../services/issue-resolution';

export function subscribeTaskLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: ['api::task.task'],

    async afterCreate(event: any) {
      const { result } = event;
      broadcast('task:created', { documentId: result.documentId, title: result.title });
    },

    async afterUpdate(event: any) {
      const { result } = event;
      broadcast('task:updated', { documentId: result.documentId, status: result.status });

      if (result.isAgentTask && result.agentStatus === 'completed') {
        broadcast('agent:completed', { documentId: result.documentId, title: result.title });
      }

      // Check if all tasks for the parent issue are done
      if (result.status === 'done') {
        setImmediate(() => {
          checkIssueResolution(strapi, result).catch((err: any) => {
            strapi.log.error(`Issue resolution check failed: ${err}`);
          });
        });
      }
    },
  });
}
