// A test's Chrome dies with the process that started it, however that process ends (ISS-1059).
// Chrome runs in a process group of its own, so its helpers can be ended with it; an `exit` hook
// ends that group on a clean exit, and a watchdog ends it on any other: the watchdog reads a pipe
// only this process holds, and the kernel closes that pipe when this process dies, SIGKILL
// included. Four orphaned Chrome groups, about 43 processes, ran for eleven days on one box
// because an `exit` hook was all there was. The watchdog leaves on its own once the group is gone.

import { spawn } from "node:child_process";

/** What the watchdog runs: end group `argv[1]` when its stdin closes, and leave once it is gone. */
const WATCHDOG = `
const group = Number(process.argv[1]);
const gone = () => { try { process.kill(-group, 0); return false; } catch { return true; } };
const end = () => { if (!gone()) process.kill(-group, "SIGKILL"); process.exit(0); };
process.stdin.on("end", end);
process.stdin.on("error", end);
process.stdin.resume();
setInterval(() => { if (gone()) process.exit(0); }, 500);
`;

/**
 * Spawns `bin` with `args` in a process group of its own, tied to this process: the group is
 * killed when this process exits cleanly, and by a watchdog when it dies any other way. Answers
 * the child; its pid is the group to end. `options` are `spawn`'s, bar `detached`, which is
 * always on.
 *
 * @param {string} bin
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnTied(bin, args, options = {}) {
  const child = spawn(bin, args, { ...options, detached: true });
  const group = child.pid;
  // a binary that could not start has no group; its `error` event is the caller's to name
  if (group === undefined) return child;
  const end = () => {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // the group is already gone
    }
  };
  process.once("exit", end);
  // detached, so a signal to this process's group (Ctrl-C, a runner ending its pane) leaves the
  // watchdog standing to do its one job
  const watchdog = spawn(process.execPath, ["-e", WATCHDOG, String(group)], { stdio: ["pipe", "ignore", "ignore"], detached: true });
  watchdog.stdin?.on("error", () => undefined);
  watchdog.once("exit", () => process.off("exit", end));
  // neither the watchdog nor its pipe keeps this process alive
  watchdog.unref();
  /** @type {import("node:net").Socket} */ (/** @type {unknown} */ (watchdog.stdin)).unref();
  return child;
}
