import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { APP_VERSION } from "@dragon-control/core";
import type { ActionRunner } from "../actions/service";
import { ForbiddenAuthError, UnauthorizedError } from "../auth/service";
import type { DbHandle } from "../db/client";
import type { Agents } from "./service";
import { registerTools } from "./tools";
import type { Addons } from "../addons";

/**
 * Hearth's MCP endpoint. Only reachable with a short-lived agent
 * key issued for one session (the auth guard checks the key and its
 * scope first); each request gets a fresh, stateless server bound to that
 * session's context.
 */
export function registerMcp(
  app: FastifyInstance,
  deps: {
    handle: DbHandle;
    runner: ActionRunner;
    agents: Agents;
    demo: boolean;
    /** Add-ons' tools join Ember's (after hers, so they get the same activity and limits). */
    addons?: Addons;
  },
) {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/api/mcp",
    handler: async (request, reply) => {
      const key = request.key;
      if (!key || key.kind !== "agent")
        throw new ForbiddenAuthError("Only agent sessions use this.");
      const ctx = deps.agents.contexts.get(key.id);
      if (!ctx) throw new UnauthorizedError("This agent session has ended.");

      const server = new McpServer({ name: "dragon-control", version: APP_VERSION });
      registerTools(
        server,
        { handle: deps.handle, runner: deps.runner, demo: deps.demo, cave: deps.agents.cave },
        ctx,
      );
      deps.addons?.addTools(server, ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
