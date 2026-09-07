// REST status codes for the transport-agnostic errors `updatePipelineConfig`
// throws. Kept out of the service so it stays usable from MCP, which reports
// the same codes as strings.

import { HTTPException } from 'hono/http-exception';
import { PipelineConfigError } from '../pipeline/pipeline-config-service.js';

// cm:guard the switch is EXHAUSTIVE on purpose — a new PipelineConfigErrorCode with no case here compiles but escapes as an unmapped 500, which is how a rejected config patch reads to the UI as a server fault
export function pipelineConfigHttpError(err: unknown): unknown {
  if (!(err instanceof PipelineConfigError)) return err;
  const cause = { code: err.code, details: err.details };
  switch (err.code) {
    case 'OPEN_LOCKED_ON':
    case 'STAGE_POOL_UNKNOWN_RUNNER':
    // cm:why 400, not 409: the two settings CONFLICT with each other, they do not conflict with live state the operator could wait out. Retrying is never the answer; editing one of the two named settings is.
    case 'CONFIG_CONFLICT':
      return new HTTPException(400, { message: err.message, cause });
    case 'STAGE_HAS_ISSUES':
      return new HTTPException(409, { message: err.message, cause });
    case 'PROJECT_NOT_FOUND':
      return new HTTPException(404, { message: 'not found', cause: { code: 'NOT_FOUND' } });
  }
}
