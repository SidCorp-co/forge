import { useEffect, useState } from "react";
import { invoke } from "@/hooks/use-tauri-ipc";
import { Modal } from "@/components/ui/modal";

/**
 * ISS-278 conflict-resolution dialog. Mounted in the app shell, listens for
 * `skill-conflict` events emitted by `skill-sync.ts` after each refresh.
 * The user picks one of:
 *   - Keep local: file untouched, pair added to `local_overrides` so
 *     subsequent refreshes silently skip it.
 *   - Overwrite: library content written through; baseline updated.
 *   - Diff: in-place toggle, no state change.
 */

interface SkillConflict {
  slug: string;
  skillName: string;
  localContent: string;
  serverContent: string;
  detail: string;
}

export function SkillConflictDialog() {
  const [queue, setQueue] = useState<SkillConflict[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const handle = await listen<SkillConflict>("skill-conflict", (event) => {
          if (!event.payload) return;
          // De-duplicate: if the same (slug, skillName) is already queued,
          // replace the entry rather than stacking — the latest server
          // content is the one the user should review.
          setQueue((prev) => {
            const filtered = prev.filter(
              (q) =>
                q.slug !== event.payload.slug ||
                q.skillName !== event.payload.skillName,
            );
            return [...filtered, event.payload];
          });
        });
        if (cancelled) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch (err) {
        console.error("[skill-conflict-dialog] listen failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const head = queue[0];
  if (!head) return null;

  const advance = () => {
    setShowDiff(false);
    setBusy(false);
    setQueue((prev) => prev.slice(1));
  };

  const onKeepLocal = async () => {
    setBusy(true);
    try {
      await invoke("accept_local_skill", {
        slug: head.slug,
        name: head.skillName,
      });
    } catch (err) {
      console.error("[skill-conflict-dialog] accept_local_skill failed:", err);
    }
    advance();
  };

  const onOverwrite = async () => {
    setBusy(true);
    try {
      await invoke("force_install_skill_to_project", {
        slug: head.slug,
        name: head.skillName,
      });
    } catch (err) {
      console.error(
        "[skill-conflict-dialog] force_install_skill_to_project failed:",
        err,
      );
    }
    advance();
  };

  return (
    <Modal open={true} onClose={busy ? () => {} : advance}>
      <div className="px-6 py-5">
        <header className="mb-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Skill conflict — {head.skillName}
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Project <code className="rounded bg-gray-100 px-1">{head.slug}</code>{" "}
            has a locally-edited <code>SKILL.md</code> and the server version has
            also changed. Pick how to reconcile.
          </p>
          {queue.length > 1 && (
            <p className="mt-1 text-xs text-gray-500">
              {queue.length - 1} more conflict
              {queue.length - 1 === 1 ? "" : "s"} after this.
            </p>
          )}
        </header>

        <div className="mb-4 max-h-[40vh] overflow-auto rounded border border-gray-200 bg-gray-50">
          {showDiff ? (
            <div className="grid grid-cols-2 divide-x divide-gray-200">
              <div>
                <div className="border-b border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-500">
                  Local (yours)
                </div>
                <pre className="whitespace-pre-wrap p-3 text-xs text-gray-800">
                  {head.localContent}
                </pre>
              </div>
              <div>
                <div className="border-b border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-500">
                  Server
                </div>
                <pre className="whitespace-pre-wrap p-3 text-xs text-gray-800">
                  {head.serverContent}
                </pre>
              </div>
            </div>
          ) : (
            <div>
              <div className="border-b border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-500">
                Local (yours)
              </div>
              <pre className="whitespace-pre-wrap p-3 text-xs text-gray-800">
                {head.localContent}
              </pre>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => setShowDiff((v) => !v)}
            disabled={busy}
          >
            {showDiff ? "Hide diff" : "Diff vs server"}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={onKeepLocal}
              disabled={busy}
            >
              Keep local
            </button>
            <button
              type="button"
              className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              onClick={onOverwrite}
              disabled={busy}
            >
              Overwrite with server
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
