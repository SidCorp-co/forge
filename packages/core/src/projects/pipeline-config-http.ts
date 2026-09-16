// REST status codes for the transport-agnostic errors `updatePipelineConfig`
// throws. Kept out of the service so it stays usable from MCP, which reports
// the same codes as strings.

import { HTTPException } from 'hono/http-exception';
import { PipelineConfigError } from '../pipeline/pipeline-config-service.js';

export function pipelineConfigHttpError(err: unknown): unknown {
  if (!(err instanceof PipelineConfigError)) return err;
  const cause = { code: err.code, details: err.details };
  switch (err.code) {
    case 'OPEN_LOCKED_ON':
    case 'STAGE_POOL_UNKNOWN_RUNNER':
    case 'CONFIG_CONFLICT':
      return new HTTPException(400, { message: err.message, cause });
    case 'STAGE_HAS_ISSUES':
      return new HTTPException(409, { message: err.message, cause });
    case 'PROJECT_NOT_FOUND':
      return new HTTPException(404, { message: 'not found', cause: { code: 'NOT_FOUND' } });
  }
}
