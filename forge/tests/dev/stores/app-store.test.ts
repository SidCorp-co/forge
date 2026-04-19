import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import type { AgentMessage, AppConfig } from "@/lib/types";

describe("app-store", () => {
  beforeEach(() => {
    // Reset store to initial state
    useAppStore.setState({
      activeProject: null,
      wsConnected: false,
      agentMessages: [],
      agentRunning: false,
      agentSessionId: null,
      config: { strapiUrl: "http://localhost:1337", authToken: "", projects: {} },
      sidebarOpen: true,
    });
  });

  it("has correct initial state values", () => {
    const state = useAppStore.getState();
    expect(state.activeProject).toBeNull();
    expect(state.wsConnected).toBe(false);
    expect(state.agentMessages).toEqual([]);
    expect(state.agentRunning).toBe(false);
    expect(state.config.strapiUrl).toBe("http://localhost:1337");
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

  it("setConfig updates config", () => {
    const newConfig: AppConfig = {
      strapiUrl: "http://example.com",
      authToken: "abc123",
      projects: {},
    };
    useAppStore.getState().setConfig(newConfig);
    expect(useAppStore.getState().config).toEqual(newConfig);
  });
});
