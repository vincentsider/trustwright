// src/webmcp/memoryHost.ts
//
// An in-memory ModelContextHost. The browser gets its host from the platform
// (document/navigator.modelContext); the server-side gauntlet has none, so it
// arms a level against this instead. It implements just enough of the contract
// for the attack-spec interpreter: registerTool (with AbortSignal-driven
// unregistration, so a phase swap disposes the old surface), getTools, and
// executeTool. Nothing here is browser-specific, so the SAME level engine runs
// unchanged over an in-memory host as over a native one.

import type {
  ModelContextHost,
  ModelContextTool,
  RegisteredTool,
  RegisterToolOptions,
} from './types.ts';

/** A fresh, isolated in-memory host. One per run/replay: it holds no global state. */
export function createMemoryHost(): ModelContextHost {
  const tools = new Map<string, ModelContextTool>();

  return {
    async registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<unknown> {
      tools.set(tool.name, tool);
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) {
          tools.delete(tool.name);
        } else {
          signal.addEventListener(
            'abort',
            () => {
              // Only remove if THIS registration is still the live one — a later
              // phase may have re-registered the same name (guards a swap race).
              if (tools.get(tool.name) === tool) tools.delete(tool.name);
            },
            { once: true },
          );
        }
      }
      return undefined;
    },

    async getTools(): Promise<RegisteredTool[]> {
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
    },

    async executeTool(toolRef: RegisteredTool | string, input: string): Promise<string | null> {
      const name = typeof toolRef === 'string' ? toolRef : toolRef.name;
      const tool = tools.get(name);
      if (!tool) return null;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = input ? (JSON.parse(input) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
      return tool.execute(parsed, {});
    },
  };
}
