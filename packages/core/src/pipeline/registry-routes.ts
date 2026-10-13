import { Hono } from 'hono';
import { answer } from '../api-reference/describe.js';
import { getPipelineRegistry } from './registry.js';
import { readRegistry, registrySchema } from './registry-routes-reference.js';

export const pipelineRegistryRoutes = new Hono();

pipelineRegistryRoutes.get('/', readRegistry, (c) =>
  c.json(answer(registrySchema, getPipelineRegistry())),
);
