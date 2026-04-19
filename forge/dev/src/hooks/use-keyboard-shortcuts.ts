import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const activeProject = useAppStore((s) => s.activeProject);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
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
        // Close any open modals by dispatching a custom event
        window.dispatchEvent(new CustomEvent("forge:close-modal"));
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, activeProject]);
}
