import type { Core } from '@strapi/strapi';
import { broadcast } from '../services/websocket';

const UID = 'api::app-release.app-release';

export function subscribeAppReleaseLifecycles(strapi: Core.Strapi) {
  strapi.db.lifecycles.subscribe({
    models: [UID],

    async afterCreate(event: any) {
      const { result } = event;
      if (result?.isCurrent) {
        broadcast('app-release:published', {
          version: result.version,
          platform: result.platform,
          notes: result.notes,
        });
        strapi.log.info(`[app-release] Broadcast new release v${result.version} (${result.platform})`);
      }
    },

    async afterUpdate(event: any) {
      const { result } = event;
      if (result?.isCurrent) {
        broadcast('app-release:published', {
          version: result.version,
          platform: result.platform,
          notes: result.notes,
        });
        strapi.log.info(`[app-release] Broadcast updated release v${result.version} (${result.platform})`);
      }
    },
  });
}
