import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPluginRegistry,
  type Agent,
  type PluginRegistry,
  type Runtime,
  type RuntimeHandle,
  type SCM,
  type Tracker,
  type Workspace,
} from "@composio/ao-core";

interface CreateMockRegistryOptions {
  workspaceRoot: string;
  tracker?: Tracker;
  scm?: SCM;
  runtimeName?: string;
  agentName?: string;
  workspaceName?: string;
}

export interface MockRegistryHarness {
  registry: PluginRegistry;
  runtime: Runtime;
  agent: Agent;
  workspace: Workspace;
}

function makeHandle(id: string, runtimeName: string): RuntimeHandle {
  return { id, runtimeName, data: {} };
}

export function createMockRegistry({
  workspaceRoot,
  tracker,
  scm,
  runtimeName = "mock-runtime",
  agentName = "mock-agent",
  workspaceName = "mock-workspace",
}: CreateMockRegistryOptions): MockRegistryHarness {
  const runtime: Runtime = {
    name: runtimeName,
    create: async ({ sessionId }) => makeHandle(`rt-${sessionId}`, runtimeName),
    destroy: async () => {},
    sendMessage: async () => {},
    getOutput: async () => "",
    isAlive: async () => true,
  };

  const agent: Agent = {
    name: agentName,
    processName: agentName,
    getLaunchCommand: ({ sessionId, model }) =>
      model ? `${agentName} --session ${sessionId} --model ${model}` : `${agentName} --session ${sessionId}`,
    getEnvironment: () => ({}),
    detectActivity: () => "active",
    getActivityState: async () => ({ state: "active" }),
    isProcessRunning: async () => true,
    getSessionInfo: async () => null,
  };

  const workspace: Workspace = {
    name: workspaceName,
    create: async ({ projectId, sessionId, branch }) => {
      const path = join(workspaceRoot, projectId, sessionId);
      mkdirSync(path, { recursive: true });
      return { path, branch, sessionId, projectId };
    },
    destroy: async () => {},
    list: async () => [],
    exists: async (workspacePath) => {
      mkdirSync(workspacePath, { recursive: true });
      return true;
    },
  };

  const registry = createPluginRegistry();

  registry.register({
    manifest: { slot: "runtime", name: runtimeName, version: "0.0.0", description: "mock runtime" },
    create: () => runtime,
  });
  registry.register({
    manifest: { slot: "agent", name: agentName, version: "0.0.0", description: "mock agent" },
    create: () => agent,
  });
  registry.register({
    manifest: {
      slot: "workspace",
      name: workspaceName,
      version: "0.0.0",
      description: "mock workspace",
    },
    create: () => workspace,
  });

  if (tracker) {
    registry.register({
      manifest: {
        slot: "tracker",
        name: tracker.name,
        version: "0.0.0",
        description: "mock tracker",
      },
      create: () => tracker,
    });
  }

  if (scm) {
    registry.register({
      manifest: {
        slot: "scm",
        name: scm.name,
        version: "0.0.0",
        description: "mock scm",
      },
      create: () => scm,
    });
  }

  return { registry, runtime, agent, workspace };
}
