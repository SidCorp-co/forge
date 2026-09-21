import { Hono } from 'hono';
import { getPipelineRegistry } from './registry.js';

export const pipelineRegistryRoutes = new Hono();

pipelineRegistryRoutes.get('/', (c) => c.json(getPipelineRegistry()));
