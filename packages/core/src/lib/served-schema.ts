import { SERVED_SCHEMA_PATH } from '@forge/contracts/project-config';
import { env } from './env.js';

/**
 * The URL a JSON schema resolves at, on the core that serves it: `<origin>/api/schemas/<file>`.
 * A schema's `$id` (`@forge/contracts/project-config:SCHEMA_BASE`) is an identifier that no host
 * answers, so every text that sends a reader to a schema names this URL beside it.
 */
export function servedSchemaUrl(file: string): string {
  const origin = (env.PUBLIC_API_BASE_URL ?? env.APP_BASE_URL).replace(/\/+$/, '');
  return `${origin}${SERVED_SCHEMA_PATH}/${file}`;
}
