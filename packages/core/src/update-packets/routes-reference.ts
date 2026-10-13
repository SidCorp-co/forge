import { describeOperation, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { updatePackets } from '../db/schema.js';

export const updatePacketSchema = tableRow(updatePackets);

export const publishUpdatePacket = describeOperation({
  summary: 'Publish an update packet: a change, the story behind it and what it applies to',
  responses: { 201: json(updatePacketSchema, 'The packet as stored') },
});
