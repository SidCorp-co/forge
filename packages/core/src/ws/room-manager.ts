// The one RoomManager instance, in a module that reaches nothing but the class.
//
// It used to live in `server.ts`, which imports the runner heartbeat handlers —
// so every one of the 27 files that only wanted to publish into a room pulled the
// whole WS server with it, and `heartbeat-ws.ts` and `server.ts` were a cycle.

import { RoomManager } from './rooms.js';

export const roomManager = new RoomManager();
