declare module "@composio/ao-plugin-agent-*" {
  import type { Agent, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Agent>;
  export default plugin;
}

declare module "@composio/ao-plugin-runtime-*" {
  import type { PluginModule, Runtime } from "@composio/ao-core";

  const plugin: PluginModule<Runtime>;
  export default plugin;
}

declare module "@composio/ao-plugin-workspace-*" {
  import type { PluginModule, Workspace } from "@composio/ao-core";

  const plugin: PluginModule<Workspace>;
  export default plugin;
}

declare module "@composio/ao-plugin-tracker-*" {
  import type { PluginModule, Tracker } from "@composio/ao-core";

  const plugin: PluginModule<Tracker>;
  export default plugin;
}

declare module "@composio/ao-plugin-notifier-*" {
  import type { Notifier, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Notifier>;
  export default plugin;
}

declare module "@composio/ao-plugin-terminal-*" {
  import type { PluginModule, Terminal } from "@composio/ao-core";

  const plugin: PluginModule<Terminal>;
  export default plugin;
}

declare module "@composio/ao-plugin-agent-claude-code" {
  import type { Agent, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Agent>;
  export default plugin;

  export function toClaudeProjectPath(projectPath: string): string;
}
