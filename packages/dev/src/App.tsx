import { BrowserRouter, Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom";
import { Sentry } from "@/lib/sentry";
import { Sidebar } from "@/components/sidebar";
import { Dashboard, PmInbox, Settings, LoginPage, UsagePage } from "@/pages/app";
import { ProjectIssues, NewIssuePage, ProjectBoard, AgentChat, ProjectSettings, KnowledgePage, McpPage, ProjectOverview, ProjectPipeline } from "@/pages/project";
import { ProjectAgents } from "@/pages/project/ProjectAgents";
import { ChatPreview } from "@/pages/preview/ChatPreview";
import { SkillConflictDialog } from "@/components/skill-conflict-dialog";
import { useWebSocket } from "@/hooks/use-web-socket";
import { useLocalConfig } from "@/hooks/use-local-config";
import { useAutoUpdater } from "@/hooks/use-auto-updater";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useAuth } from "@/hooks/useAuth";

function AuthSplash() {
  return (
    <div className="flex h-full items-center justify-center bg-white">
      <div className="text-xs font-mono uppercase tracking-widest text-gray-400">
        Loading…
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { phase } = useAuth();
  const location = useLocation();
  if (phase === "hydrating") return <AuthSplash />;
  if (phase !== "authenticated") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function ProjectLayout() {
  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

function AppInner() {
  useWebSocket();
  useLocalConfig();
  useKeyboardShortcuts();
  const { phase } = useAuth();
  const updater = useAutoUpdater();
  const isLoggedIn = phase === "authenticated";

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Update banner — shows different states */}
      {updater.error && (
        <div className="flex items-center justify-between bg-amber-500 px-4 py-2 text-sm text-white">
          <span>{updater.error}</span>
          <div className="flex gap-2">
            <button onClick={() => updater.checkForUpdate()} className="rounded bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30">
              Retry
            </button>
            <button onClick={updater.dismissError} className="rounded bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30">
              Dismiss
            </button>
          </div>
        </div>
      )}
      {updater.readyToRestart && (
        <div className="flex items-center justify-between bg-green-600 px-4 py-2 text-sm text-white">
          <span>Update installed{updater.version ? ` (v${updater.version})` : ""}. Restart to apply.</span>
          <button onClick={updater.restartApp} className="rounded bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30">
            Restart Now
          </button>
        </div>
      )}
      {updater.downloading && !updater.readyToRestart && (
        <div className="flex items-center gap-3 bg-blue-600 px-4 py-2 text-sm text-white">
          <span>Downloading update{updater.version ? ` v${updater.version}` : ""}... {updater.progress}%</span>
          <div className="h-1.5 flex-1 rounded-full bg-white/20">
            <div className="h-full rounded-full bg-white transition-all" style={{ width: `${updater.progress}%` }} />
          </div>
        </div>
      )}
      {updater.updateAvailable && !updater.downloading && !updater.readyToRestart && !updater.error && (
        <div className="flex items-center justify-between bg-blue-600 px-4 py-2 text-sm text-white">
          <span>A new version{updater.version ? ` (v${updater.version})` : ""} of Forge Dev is available.</span>
          <button onClick={updater.installUpdate} className="rounded bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30">
            Update Now
          </button>
        </div>
      )}
      {isLoggedIn && <SkillConflictDialog />}
      <div className="flex flex-1 overflow-hidden">
        {isLoggedIn && <Sidebar />}
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/preview" element={<ChatPreview />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
            <Route path="/project/:slug" element={<RequireAuth><ProjectLayout /></RequireAuth>}>
              <Route path="overview" element={<ProjectOverview />} />
              <Route path="issues" element={<ProjectIssues />} />
              <Route path="issues/new" element={<NewIssuePage />} />
              <Route path="board" element={<ProjectBoard />} />
              <Route path="agent" element={<AgentChat />} />
              <Route path="agents" element={<ProjectAgents />} />
              <Route path="knowledge" element={<KnowledgePage />} />
              <Route path="mcp" element={<McpPage />} />
              {/* Skills managed via web UI — desktop only handles execution */}
              <Route path="pipeline" element={<ProjectPipeline />} />
              <Route path="settings" element={<ProjectSettings />} />
            </Route>
            <Route path="/usage" element={<RequireAuth><UsagePage /></RequireAuth>} />
            <Route path="/pm" element={<RequireAuth><PmInbox /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ErrorFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        <p className="font-semibold">Something went wrong.</p>
        <p className="mt-1 text-xs text-red-600">
          The error was reported. Try reloading; if it persists, sign out and back in.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  );
}
