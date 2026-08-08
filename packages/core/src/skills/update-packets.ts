import type { CreateUpdatePacketInput } from '@forge/contracts';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { type SkillActivityTrigger, updatePacketIntentClasses } from '../db/schema.js';
import { updatePackets } from '../db/schema.js';
import { recordSkillActivityEvent } from './activity.js';

export interface CreateUpdatePacketOptions {
  /** `human:<user>` | `agent:master` | `system:seeder` | `runner:<device>` — passed through to the activity log. */
  actor: string;
  trigger: SkillActivityTrigger;
}

// cm:edge contract -> packages/contracts/src/update-packets.ts — createUpdatePacketInputSchema mirrors this; kept in sync by update-packets.test.ts
const inputSchema = z.object({
  change: z.string(),
  story: z.string().trim().min(1, 'story is required'),
  intentClass: z.enum(updatePacketIntentClasses),
  appliesTo: z.string().min(1),
  provenance: z
    .object({
      commit: z.string().optional(),
      version: z.string().optional(),
      author: z.string().optional(),
    })
    .optional(),
});

// cm:guard validates BEFORE the insert — the DB CHECK on `story` is a backstop,
// not the enforcement point, per Update Pipeline §3 ("enforce at the write boundary").
export async function createUpdatePacket(
  db: Db,
  input: CreateUpdatePacketInput,
  options: CreateUpdatePacketOptions,
) {
  const parsed = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(updatePackets)
      .values({
        change: parsed.change,
        story: parsed.story,
        intentClass: parsed.intentClass,
        appliesTo: parsed.appliesTo,
        provenance: parsed.provenance ?? {},
      })
      .returning();
    if (!row) throw new Error('update packet insert returned no row');
    await recordSkillActivityEvent(tx, {
      eventType: 'packet.published',
      actor: options.actor,
      trigger: options.trigger,
      packetId: row.id,
      deltaSummary: parsed.appliesTo,
    });
    return row;
  });
}
