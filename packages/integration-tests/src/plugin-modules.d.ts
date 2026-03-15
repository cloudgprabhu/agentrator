declare module "@composio/ao-plugin-agent-*" {
  import type { Agent, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Agent>;
  export default plugin;
}

declare module "@composio/ao-plugin-runtime-*" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { PluginModule, Runtime } from "@composio/ao-core";

  const plugin: PluginModule<Runtime>;
  export default plugin;
}

declare module "@composio/ao-plugin-workspace-*" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { PluginModule, Workspace } from "@composio/ao-core";

  const plugin: PluginModule<Workspace>;
  export default plugin;
}

declare module "@composio/ao-plugin-tracker-*" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { PluginModule, Tracker } from "@composio/ao-core";

  const plugin: PluginModule<Tracker>;
  export default plugin;
}

declare module "@composio/ao-plugin-notifier-*" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { Notifier, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Notifier>;
  export default plugin;
}

declare module "@composio/ao-plugin-terminal-*" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { PluginModule, Terminal } from "@composio/ao-core";

  const plugin: PluginModule<Terminal>;
  export default plugin;
}

declare module "@composio/ao-plugin-agent-claude-code" {
  // eslint-disable-next-line no-duplicate-imports -- separate ambient module declaration requires its own import
  import type { Agent, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Agent>;
  export default plugin;

  export function toClaudeProjectPath(projectPath: string): string;
}
