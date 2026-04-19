import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { getProjects, getPipelineTelemetry } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useLogout } from "@/hooks/use-logout";
import { NotificationBell } from "./notification-bell";
import clsx from "clsx";

const projectSubPages = [
  { path: "overview", label: "Overview" },
  { path: "issues", label: "Issues" },
  { path: "board", label: "Board" },
  { path: "agent", label: "Agent" },
  { path: "agents", label: "Agents" },
  { path: "knowledge", label: "Knowledge" },
  { path: "mcp", label: "MCP" },
  { path: "settings", label: "Settings" },
];

export function Sidebar() {
  const location = useLocation();
  const logout = useLogout();
  const { wsConnected, sidebarOpen } = useAppStore();
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: getProjects,
    refetchInterval: 30000,
  });
  const { data: telemetry } = useQuery({
    queryKey: ["pipeline-telemetry"],
    queryFn: getPipelineTelemetry,
    refetchInterval: 60000,
  });

  if (!sidebarOpen) return null;

  return (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-50">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
        <span className="text-lg font-bold text-gray-900">Forge</span>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <span
            className={clsx(
              "h-2 w-2 rounded-full",
              wsConnected ? "bg-green-500" : "bg-red-400",
            )}
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        <Link
          to="/"
          className={clsx(
            "block px-4 py-2 text-sm",
            location.pathname === "/"
              ? "bg-gray-200 text-gray-900 font-medium"
              : "text-gray-600 hover:text-gray-900 hover:bg-gray-100",
          )}
        >
          Dashboard
        </Link>

        {projects?.map((p) => {
          const isActive = location.pathname.startsWith(`/project/${p.slug}`);
          return (
            <div key={p.slug}>
              <Link
                to={`/project/${p.slug}/issues`}
                className={clsx(
                  "block px-4 py-2 text-sm font-medium",
                  isActive
                    ? "text-gray-900"
                    : "text-gray-600 hover:text-gray-900",
                )}
              >
                {p.name}
              </Link>
              {isActive && (
                <div className="ml-4 border-l border-gray-200 pl-2">
                  {projectSubPages.map((sub) => {
                    const subPath = `/project/${p.slug}/${sub.path}`;
                    const isSubActive = location.pathname === subPath;
                    return (
                      <Link
                        key={sub.path}
                        to={subPath}
                        className={clsx(
                          "block px-3 py-1.5 text-xs",
                          isSubActive
                            ? "bg-gray-200 text-gray-900 font-medium"
                            : "text-gray-500 hover:text-gray-700 hover:bg-gray-100",
                        )}
                      >
                        {sub.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <Link
          to="/usage"
          className={clsx(
            "block px-4 py-2 text-sm",
            location.pathname === "/usage"
              ? "bg-gray-200 text-gray-900 font-medium"
              : "text-gray-600 hover:text-gray-900 hover:bg-gray-100",
          )}
        >
          Usage
        </Link>
      </nav>

      <div className="border-t border-gray-200 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span
            className={clsx(
              "h-2 w-2 rounded-full",
              wsConnected ? "bg-green-500" : "bg-amber-400",
            )}
          />
          {wsConnected ? "Connected" : "Reconnecting..."}
        </div>
        {telemetry && (
          <div className="text-xs text-gray-500 tabular-nums">
            Retries: {telemetry.autoRetries} | Recovered: {telemetry.recovered}
          </div>
        )}
        <div className="flex items-center justify-between">
          <Link
            to="/settings"
            className="text-xs text-gray-500 hover:text-gray-900"
          >
            Settings
          </Link>
          <button
            onClick={logout}
            className="text-xs text-red-500 hover:text-red-700"
          >
            Logout
          </button>
        </div>
      </div>
    </aside>
  );
}
