import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type ProjectConfigSchemaName, projectConfigJsonSchemas, schemaId } from './json-schema.js';

export const projectConfigSchemaRoutes = new Hono();

const SERVED = new Map(
  (Object.keys(projectConfigJsonSchemas) as ProjectConfigSchemaName[]).map((name) => [
    schemaId(name).slice(schemaId(name).lastIndexOf('/') + 1),
    projectConfigJsonSchemas[name],
  ]),
);

projectConfigSchemaRoutes.get('/schemas/:file', (c) => {
  const file = c.req.param('file');
  const schema = SERVED.get(file);
  if (!schema) {
    throw new HTTPException(404, {
      message: `no schema "${file}"; served: ${[...SERVED.keys()].join(', ')}`,
      cause: { code: 'SCHEMA_NOT_FOUND' },
    });
  }
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(schema);
});
