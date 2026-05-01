import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import type { AgentMessage } from "@/lib/types";

describe("app-store", () => {
  beforeEach(() => {
    // Reset store to initial state. Auth-bearing fields (coreUrl/token/deviceId)
    // moved to auth-store; only device-side settings + ephemeral UI state live
    // here now.
    useAppStore.setState({
      activeProject: null,
      wsConnected: false,
      agentMessages: [],
      agentRunning: false,
      agentSessionId: null,
      deviceSettings: { projects: {} },
      sidebarOpen: true,
    });
  });

  it("has correct initial state values", () => {
    const state = useAppStore.getState();
    expect(state.activeProject).toBeNull();
    expect(state.wsConnected).toBe(false);
    expect(state.agentMessages).toEqual([]);
    expect(state.agentRunning).toBe(false);
    expect(state.deviceSettings.projects).toEqual({});
    expect(state.sidebarOpen).toBe(true);
  });

  it("setActiveProject updates state", () => {
    useAppStore.getState().setActiveProject("my-project");
    expect(useAppStore.getState().activeProject).toBe("my-project");
  });

  it("setWsConnected updates state", () => {
    useAppStore.getState().setWsConnected(true);
    expect(useAppStore.getState().wsConnected).toBe(true);
  });

  it("addAgentMessage appends to array", () => {
    const msg: AgentMessage = {
      id: "1",
      type: "assistant",
      timestamp: Date.now(),
      content: "hi",
    };
    useAppStore.getState().addAgentMessage(msg);
    expect(useAppStore.getState().agentMessages).toHaveLength(1);
    expect(useAppStore.getState().agentMessages[0]).toEqual(msg);
  });

  it("clearAgentMessages resets array", () => {
    const msg: AgentMessage = {
      id: "1",
      type: "assistant",
      timestamp: Date.now(),
      content: "hi",
    };
    useAppStore.getState().addAgentMessage(msg);
    useAppStore.getState().clearAgentMessages();
    expect(useAppStore.getState().agentMessages).toEqual([]);
  });

  it("setDeviceSettings replaces the slice", () => {
    useAppStore.getState().setDeviceSettings({
      projects: { demo: { slug: "demo", repoPath: "/r/demo" } },
      projectsRoot: "/forge",
    });
    const s = useAppStore.getState().deviceSettings;
    expect(s.projects.demo?.repoPath).toBe("/r/demo");
    expect(s.projectsRoot).toBe("/forge");
  });

  it("patchDeviceSettings merges into the slice", () => {
    useAppStore.getState().setDeviceSettings({
      projects: { demo: { slug: "demo", repoPath: "/r/demo" } },
    });
    useAppStore.getState().patchDeviceSettings({ projectsRoot: "/forge" });
    const s = useAppStore.getState().deviceSettings;
    expect(s.projects.demo?.repoPath).toBe("/r/demo");
    expect(s.projectsRoot).toBe("/forge");
  });
});
