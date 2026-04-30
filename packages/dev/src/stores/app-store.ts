import { create } from "zustand";
import type { AgentMessage, AppConfig } from "@/lib/types";

export interface AgentUsage {
  /** Last turn's full context (input + cacheRead + cacheWrite) */
  contextUsed: number;
  /** Cumulative non-cached input tokens */
  inputTotal: number;
  /** Cumulative output tokens */
  outputTotal: number;
  /** Cumulative cache-read tokens */
  cacheRead: number;
  /** Cumulative cache-creation tokens */
  cacheWrite: number;
  /** Number of API turns */
  turns: number;
}

export { CONTEXT_LIMIT } from "@/lib/constants";

const EMPTY_USAGE: AgentUsage = { contextUsed: 0, inputTotal: 0, outputTotal: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

interface AppState {
  activeProject: string | null;
  setActiveProject: (slug: string | null) => void;

  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  agentMessages: AgentMessage[];
  agentRunning: boolean;
  agentSessionId: string | null;
  agentUsage: AgentUsage;
  addAgentMessage: (msg: AgentMessage) => void;
  clearAgentMessages: () => void;
  setAgentRunning: (v: boolean) => void;
  setAgentSessionId: (id: string | null) => void;
  updateAgentUsage: (usage: NonNullable<AgentMessage["usage"]>) => void;
  updateAgentUsageFromStored: (usage: AgentUsage) => void;
  resetAgentUsage: () => void;

  config: AppConfig;
  setConfig: (c: AppConfig) => void;
  /**
   * False until `useLocalConfig` finishes hydrating from disk + the OS
   * keychain. RequireAuth and LoginPage gate on this so a fresh launch
   * doesn't bounce the user to /login while the JWT is still loading.
   */
  configReady: boolean;
  setConfigReady: (v: boolean) => void;

  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeProject: null,
  setActiveProject: (slug) => set({ activeProject: slug }),

  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  agentMessages: [],
  agentRunning: false,
  agentSessionId: null,
  agentUsage: EMPTY_USAGE,
  addAgentMessage: (msg) =>
    set((s) => ({ agentMessages: [...s.agentMessages, msg] })),
  clearAgentMessages: () => set({ agentMessages: [] }),
  setAgentRunning: (v) => set({ agentRunning: v }),
  setAgentSessionId: (id) => set({ agentSessionId: id }),
  updateAgentUsage: (usage) =>
    set((s) => {
      const inp = usage.input_tokens || 0;
      const cr  = usage.cache_read_input_tokens || 0;
      const cw  = usage.cache_creation_input_tokens || 0;
      return {
        agentUsage: {
          contextUsed: inp + cr + cw,
          inputTotal: s.agentUsage.inputTotal + inp,
          outputTotal: s.agentUsage.outputTotal + (usage.output_tokens || 0),
          cacheRead: s.agentUsage.cacheRead + cr,
          cacheWrite: s.agentUsage.cacheWrite + cw,
          turns: s.agentUsage.turns + 1,
        },
      };
    }),
  updateAgentUsageFromStored: (usage) => set({ agentUsage: { ...EMPTY_USAGE, ...usage } }),
  resetAgentUsage: () =>
    set({ agentUsage: EMPTY_USAGE }),

  config: {
    coreUrl: "http://localhost:8080",
    authToken: "",
    projects: {},
    deviceId: "",
  },
  setConfig: (c) => set({ config: c }),
  configReady: false,
  setConfigReady: (v) => set({ configReady: v }),

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
