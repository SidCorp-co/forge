import { z } from 'zod';
import { describeOperation, fail, json, raw } from '../api-reference/describe.js';
import { ROOM_FORBIDDEN } from './conversation-routes-reference.js';

export const uploadTicketSchema = z.object({
  uploadId: z.string(),
  method: z.literal('PUT'),
  uploadPath: z.string(),
  maxBytes: z.number(),
  expiresAt: z.string(),
  expiresInMs: z.number(),
});

export const stoppedSchema = z.object({ conversationId: z.string(), stopped: z.number() });

const noRoom = fail('NOT_FOUND', 'there is no such room');
const roomRefused = fail(ROOM_FORBIDDEN);

export const mintRoomUpload = describeOperation({
  summary: 'Mint the ticket that puts one file in this room',
  description: 'The bytes then go to `PUT /api/uploads/:uploadId`, which owns the size limit.',
  responses: {
    201: json(uploadTicketSchema, 'The ticket, to be used once before it expires'),
    400: fail({
      MIME_NOT_ALLOWED: 'the file type is not one a room takes',
      ATTACHMENT_NAME_TAKEN: 'a file with this name is already on the room',
      INVALID_NAME: 'the name is longer than the byte budget for a name',
    }),
    403: roomRefused,
    404: noRoom,
  },
});

export const downloadRoomAttachment = describeOperation({
  summary: "Download the bytes of one of this room's attachments",
  responses: {
    200: raw('*/*', 'The file, with the content type it was stored under'),
    403: roomRefused,
    404: fail('NOT_FOUND', 'there is no such room, or no such attachment on it'),
  },
});

export const stopRoomTurn = describeOperation({
  summary: 'End the turn this room is running',
  description:
    'Only a turn this core is running can be ended here. A room running nothing, or one handed to a paired box, is refused by name.',
  responses: {
    200: json(stoppedSchema, 'How many turns were ended'),
    403: roomRefused,
    404: noRoom,
    409: fail({
      CONVERSATION_TURN_HANDED_OFF: "the turn is a paired box's; end its agent session instead",
      CONVERSATION_TURN_ON_ANOTHER_CORE:
        'a window is open under another core, which is the one that can stop it',
      CONVERSATION_NOTHING_RUNNING: 'the room is not answering anything',
    }),
  },
});
