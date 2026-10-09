// The REST surface of a POC room (REQ-44), through the contracts' `ROOM_ROUTES` so a route that moves
// there moves here. Every answer is read through `roomEnvelopeSchema` and refused by name when it is
// not one, as the preview's own api does.

import { type Room, ROOM_ROUTES, roomEnvelopeSchema } from "@forge/contracts/poc-room";
import type { KeepPreviewRequest } from "@forge/contracts/preview";
import { apiClient } from "@/lib/api/client";
import { post, read, routeOf } from "./api";

const room = (where: string, body: unknown): Room => read(where, roomEnvelopeSchema, body).room;

export const roomApi = {
  open: async (projectId: string, body: { about: string; brief: string }): Promise<Room> => room("POST room", await post(ROOM_ROUTES.ofProject, { id: projectId }, body)),
  get: async (id: string): Promise<Room> => room("GET room", await apiClient<unknown>(routeOf(ROOM_ROUTES.get, { id }))),
  join: async (id: string): Promise<Room> => room("POST join", await post(ROOM_ROUTES.join, { id })),
  ask: async (id: string, text: string): Promise<Room> => room("POST ask", await post(ROOM_ROUTES.asks, { id }, { text })),
  settleItem: async (id: string, turnId: string, text?: string): Promise<Room> => room("POST item", await post(ROOM_ROUTES.items, { id }, text ? { turnId, text } : { turnId })),
  unsettleItem: async (id: string, itemId: string): Promise<Room> => room("DELETE item", await apiClient<unknown>(routeOf(ROOM_ROUTES.item, { id, itemId }), { method: "DELETE" })),
  settle: async (id: string, body: KeepPreviewRequest): Promise<Room> => room("POST settle", await post(ROOM_ROUTES.settle, { id }, body)),
  abandon: async (id: string, reason?: string): Promise<Room> => room("POST abandon", await post(ROOM_ROUTES.abandon, { id }, reason ? { reason } : {})),
};
