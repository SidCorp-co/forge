import { logger } from '../logger.js';

export const JOB_AXIS_SCAN_LIMIT = 200;

/** Report a filled page, then hand the hop's result straight back to its caller. */
export function reportHopPage<T>(hop: string, examined: number, result: T): T {
  if (examined >= JOB_AXIS_SCAN_LIMIT) {
    logger.warn(
      { hop, limit: JOB_AXIS_SCAN_LIMIT, examined },
      'loop-monitor: hop filled its candidate page — the rest is read on the next tick',
    );
  }
  return result;
}
