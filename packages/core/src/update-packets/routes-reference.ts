import { describeOperation, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { updatePackets } from '../db/schema.js';

export const updatePacketSchema = tableRow(updatePackets);

export const publishUpdatePacket = describeOperation({
  summary: 'Publish an update packet: a change, the story behind it and what it applies to',
  responses: { 201: json(updatePacketSchema, 'The packet as stored') },
});
