// The face of the chat-dock feature: what other features import of it (CODE-STANDARD.md, Structure).
export { AskAboutThis } from "./ask-about-this";
export { assistantFilters, useAssistantSetFilter } from "./assistant-filters";
export { type ChatDockApi, ChatDockProvider, type DockDoor, useChatDock, useChatDockDoor, useChatDockState, usePageRoom } from "./dock";
export { type DockSize, dockOverPage, dockSizes, dockWidth, sizeAt, sizeFromDrag } from "./dock-size";
export { type ChatTarget, isScopedRoom, openingTarget, targetConversationId, waitingRoom } from "./dock-target";
export { ListFilterBar, WaitingFilter, useListFilter, useListNarrowing } from "./list-filter-bar";
export { type IssueSelectionBridge, issueSelectionBridge, useIssueSelectionBridge, useSelectedIssueKeys } from "./selection-bridge";
