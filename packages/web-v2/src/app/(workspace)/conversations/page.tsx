"use client";

// Workspace-tier Conversations index (`/conversations`) — chat-only,
// cross-project. Replaces the retired `/sessions` mixed chat+pipeline page
// (ISS-668).
import { ConversationsScreen } from "@/features/conversations/components/conversations-screen";

export default function WorkspaceConversationsPage() {
  return <ConversationsScreen />;
}
