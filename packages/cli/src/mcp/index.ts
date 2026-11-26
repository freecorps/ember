// `ember mcp [--allow-env name ...] [--allow-run name ...]`: the project as an MCP server on stdio (tools.ts).

import type { Project } from "../config.ts";
import { McpServer, serveStdio } from "./server.ts";
import { cliVersion, emberTools, instructions, type EmberMcpOptions } from "./tools.ts";

export { McpServer, PROTOCOL_VERSIONS, serveStdio, ToolError, validate, type JsonSchema, type McpTool, type ToolOutput } from "./server.ts";
export { emberTools, LOCAL, type EmberMcpOptions } from "./tools.ts";

/** The Ember MCP server of a project (not serving yet: `serveStdio(server)`). */
export function emberMcpServer(project: Project, o: Omit<EmberMcpOptions, "project"> = {}): McpServer {
  const opts = { ...o, project };
  return new McpServer({ name: "ember", title: `Ember (${project.config.project})`, version: cliVersion(), instructions: instructions(opts), tools: emberTools(opts) });
}

export async function mcpCommand(project: Project, o: Omit<EmberMcpOptions, "project"> = {}): Promise<void> {
  process.stderr.write(`ember mcp: ${project.config.project} on stdio (local ember dev${o.allowEnv?.length ? `; read: ${o.allowEnv.join(", ")}` : ""}${o.allowRun?.length ? `; run: ${o.allowRun.join(", ")}` : ""})\n`);
  await serveStdio(emberMcpServer(project, o));
}
