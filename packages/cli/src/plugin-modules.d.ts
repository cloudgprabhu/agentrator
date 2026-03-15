declare module "@composio/ao-plugin-agent-*" {
  import type { Agent, PluginModule } from "@composio/ao-core";

  const plugin: PluginModule<Agent>;
  export default plugin;
}

declare module "@composio/ao-plugin-scm-*" {
  import type { PluginModule, SCM } from "@composio/ao-core";

  const plugin: PluginModule<SCM>;
  export default plugin;
}
