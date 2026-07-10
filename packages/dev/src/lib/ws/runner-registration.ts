import { invoke } from "@/hooks/use-tauri-ipc";
import { useAppStore } from "@/stores/app-store";
import type { SendFrame } from "./ws-transport";

// ISS-271 / ISS-173: Register a `claude-code` runner with the server for
// EVERY project in deviceSettings.projects that carries a `documentId`.
// The Rust WS path goes through the `ws_send` Tauri command (ISS-173 §2);
// the browser fallback writes directly to its WebSocket.
async function buildRegisterFrame(projectId: string, skills: string[]) {
  const name = (await invoke<string>("get_hostname").catch(() => "Desktop")) || "Desktop";
  return JSON.stringify({
    type: "runner:register",
    data: {
      type: "claude-code",
      name,
      projectId,
      capabilities: { skills, maxConcurrent: 1 },
      config: {},
    },
  });
}

export async function registerAllRunners(sendFrame: SendFrame) {
  const settings = useAppStore.getState().deviceSettings;
  const projectIds = Object.values(settings.projects ?? {})
    .map((p) => p.documentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (projectIds.length === 0) return;

  let skills: string[] = [];
  try {
    const hashes = (await invoke<Record<string, string>>("get_skill_hashes")) ?? {};
    skills = Object.keys(hashes);
  } catch {
    // tauri unavailable; runner registers with empty skills
  }

  await Promise.all(
    projectIds.map(async (pid) => {
      try {
        const frame = await buildRegisterFrame(pid, skills);
        await sendFrame(frame);
      } catch (err) {
        console.warn(`[runner:register] failed for project ${pid}:`, err);
      }
    }),
  );
}

// ISS-175: subscribe to each project room so the server's `runner.status`
// broadcasts (heartbeat-ws.ts + stale-detector.ts publish into
// projectRoom(projectId)) reach this client. Re-fires on every connect.
export async function subscribeToProjectRooms(sendFrame: SendFrame) {
  const settings = useAppStore.getState().deviceSettings;
  const projectIds = Object.values(settings.projects ?? {})
    .map((p) => p.documentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const pid of projectIds) {
    const frame = JSON.stringify({ type: "subscribe", room: `project:${pid}` });
    try {
      await sendFrame(frame);
    } catch (err) {
      console.warn(`[subscribe project:${pid}] failed:`, err);
    }
  }
}
