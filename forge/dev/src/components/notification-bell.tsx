import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead } from "@/lib/api";
import type { Notification, NotificationType } from "@/lib/types";
import clsx from "clsx";

const TYPE_ICONS: Record<NotificationType, string> = {
  issue_status_changed: "●",
  comment_added: "💬",
  agent_completed: "🤖",
  mention: "@",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const invalidateNotifications = () => {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["notifications-unread"] });
  };

  const { data: unreadCount = 0 } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: getUnreadCount,
    refetchInterval: 30_000,
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: invalidateNotifications,
  });

  const markAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: invalidateNotifications,
  });

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleClick(n: Notification) {
    if (!n.read) markRead.mutate(n.documentId);
    setOpen(false);
    const slug = n.project?.slug;
    if (n.issueDocumentId && slug) {
      navigate(`/project/${slug}/issues`);
    } else if (n.agentSessionDocumentId && slug) {
      navigate(`/project/${slug}/agent`);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative rounded p-1 text-gray-500 hover:text-gray-700"
        aria-label="Notifications"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold text-gray-900">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={() => markAll.mutate()}
                className="text-[10px] text-blue-600 hover:text-blue-800"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-gray-400">No notifications</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.documentId}
                  onClick={() => handleClick(n)}
                  className={clsx(
                    "flex w-full gap-2 px-3 py-2 text-left hover:bg-gray-50",
                    !n.read && "bg-blue-50/50",
                  )}
                >
                  <span className="mt-0.5 text-xs">{TYPE_ICONS[n.type]}</span>
                  <div className="min-w-0 flex-1">
                    <p className={clsx("truncate text-xs", !n.read ? "font-medium text-gray-900" : "text-gray-700")}>
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="mt-0.5 truncate text-[10px] text-gray-500">{n.body}</p>
                    )}
                    <p className="mt-0.5 text-[10px] text-gray-400">{timeAgo(n.createdAt)}</p>
                  </div>
                  {!n.read && (
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
