import { factories } from '@strapi/strapi';
import type { ContentType } from '@strapi/types/dist/uid';

const UID = 'api::app-config.app-config' as ContentType;

export default factories.createCoreRouter(UID);
