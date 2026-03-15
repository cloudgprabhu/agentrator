declare module "@composio/ao-plugin-scm-gitlab/glab-utils" {
  export function glab(args: string[], hostname?: string): Promise<string>;
  export function parseJSON<T>(raw: string, context: string): T;
  export function extractHost(repo: string): string | undefined;
  export function stripHost(fullPath: string): string;
}
