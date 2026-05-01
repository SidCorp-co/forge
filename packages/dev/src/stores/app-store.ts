import { create } from "zustand";
import type { AgentMessage, McpServerConfig, ProjectConfig, SkillLibraryEntry } from "@/lib/types";

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

const EMPTY_USAGE: AgentUsage = {
  contextUsed: 0,
  inputTotal: 0,
  outputTotal: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
};

/**
 * Renderer-side device settings — projects map, skill library, MCP library,
 * and the projects-root parent dir. Auth-bearing fields (`coreUrl`, `token`,
 * `deviceId`) live in `auth-store.ts` so they cannot drift out of sync with
 * the api client and keychain. Fields here are orthogonal to auth.
 */
export interface DeviceSettings {
  projects: Record<string, ProjectConfig>;
  projectsRoot?: string;
  skillLibrary?: Record<string, SkillLibraryEntry>;
  mcpLibrary?: Record<string, McpServerConfig>;
}

const EMPTY_DEVICE_SETTINGS: DeviceSettings = { projects: {} };

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

  deviceSettings: DeviceSettings;
  setDeviceSettings: (s: DeviceSettings) => void;
  patchDeviceSettings: (patch: Partial<DeviceSettings>) => void;

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
  addAgentMessage: (msg) => set((s) => ({ agentMessages: [...s.agentMessages, msg] })),
  clearAgentMessages: () => set({ agentMessages: [] }),
  setAgentRunning: (v) => set({ agentRunning: v }),
  setAgentSessionId: (id) => set({ agentSessionId: id }),
  updateAgentUsage: (usage) =>
    set((s) => {
      const inp = usage.input_tokens || 0;
      const cr = usage.cache_read_input_tokens || 0;
      const cw = usage.cache_creation_input_tokens || 0;
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
  resetAgentUsage: () => set({ agentUsage: EMPTY_USAGE }),

  deviceSettings: EMPTY_DEVICE_SETTINGS,
  setDeviceSettings: (s) => set({ deviceSettings: s }),
  patchDeviceSettings: (patch) =>
    set((s) => ({ deviceSettings: { ...s.deviceSettings, ...patch } })),

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
