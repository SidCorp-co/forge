import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type ProjectConfigSchemaName, projectConfigJsonSchemas, schemaId } from './json-schema.js';

/** Serves project-config's JSON schemas and those the route registry hands in from the modules above
 *  it (ecosystem, workflows), which project-config may not import. */
export function projectConfigSchemaRoutes(...others: Readonly<Record<string, object>>[]): Hono {
  const served = new Map<string, object>([
    ...(Object.keys(projectConfigJsonSchemas) as ProjectConfigSchemaName[]).map(
      (name) =>
        [
          schemaId(name).slice(schemaId(name).lastIndexOf('/') + 1),
          projectConfigJsonSchemas[name],
        ] as const,
    ),
    ...others.flatMap((schemas) => Object.entries(schemas)),
  ]);
  return new Hono().get('/schemas/:file', (c) => {
    const file = c.req.param('file');
    const schema = served.get(file);
    if (!schema) {
      throw new HTTPException(404, {
        message: `no schema "${file}"; served: ${[...served.keys()].join(', ')}`,
        cause: { code: 'SCHEMA_NOT_FOUND' },
      });
    }
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(schema);
  });
}
