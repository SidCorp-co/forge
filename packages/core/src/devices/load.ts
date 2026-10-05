/**
 * What a master agent needs to decide how much work to take on.
 *
 * Three scopes, all raw counts: this device, this project, the project's
 * fleet. The master reads them and concludes; nothing here concludes for it.
 */

import { sql } from 'drizzle-orm';
export const OCCUPYING = sql`j.status = 'dispatched'
  AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))`;
