/* eslint-disable no-duplicate-imports */
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

declare module "@composio/ao-plugin-scm-*" {
  import type { PluginModule, SCM } from "@composio/ao-core";

  const plugin: PluginModule<SCM>;
  export default plugin;
}
