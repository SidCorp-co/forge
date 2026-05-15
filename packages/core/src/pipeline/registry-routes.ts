import { Hono } from 'hono';
import { getPipelineRegistry } from './registry.js';

// Public — no auth middleware. The registry is static, project-agnostic, and
// derivable from the open-source code; embedded widget callers fetch it
// without a device token. Mounted at `/api/pipeline/registry` from
// `../index.ts`.
export const pipelineRegistryRoutes = new Hono();

pipelineRegistryRoutes.get('/', (c) => c.json(getPipelineRegistry()));
