import { useEffect } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";

/**
 * Pure factory for the keydown handler. Extracted from `useKeyboardShortcuts`
 * so unit tests can exercise the routing branches without mounting a hook
 * (the dev-package test harness can't reliably renderHook through
 * @testing-library/react — see ISS-15 / vitest.config.ts notes on the
 * workspace dual-React mismatch).
 */
export function makeKeyboardHandler(
  navigate: NavigateFunction,
  activeProject: string | null,
): (e: KeyboardEvent) => void {
  return function handleKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) {
      const num = parseInt(e.key);
      if (num === 1) {
        e.preventDefault();
        navigate("/");
        return;
      }
      if (num === 2 && activeProject) {
        e.preventDefault();
        navigate(`/project/${activeProject}/issues`);
        return;
      }
      if (num === 3 && activeProject) {
        e.preventDefault();
        navigate(`/project/${activeProject}/board`);
        return;
      }
      if (num === 4 && activeProject) {
        e.preventDefault();
        navigate(`/project/${activeProject}/agent`);
        return;
      }
      if (num === 5) {
        e.preventDefault();
        navigate("/settings");
        return;
      }
      if (e.key === "r") {
        e.preventDefault();
        window.location.reload();
        return;
      }
    }
    if (e.key === "Escape") {
      window.dispatchEvent(new CustomEvent("forge:close-modal"));
    }
  };
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const activeProject = useAppStore((s) => s.activeProject);

  useEffect(() => {
    const handleKeyDown = makeKeyboardHandler(navigate, activeProject);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, activeProject]);
}
