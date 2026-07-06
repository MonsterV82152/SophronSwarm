/**
 * A tiny in-repo MCP server for integration testing.
 *
 * Exposes two tools — `add` and `multiply` — over stdio. Used by
 * tests/mcp/pool.live.test.ts to prove the full connect → list → call path
 * against the real @modelcontextprotocol/sdk.
 *
 * Run as: node tests/fixtures/math-mcp-server.js
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "math-test-server", version: "1.0.0" },
  { capabilities: { tools: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add",
      description: "Add two numbers and return the sum.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    {
      name: "multiply",
      description: "Multiply two numbers and return the product.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = Number(args?.["a"]);
  const b = Number(args?.["b"]);
  if (name === "add") {
    return { content: [{ type: "text", text: String(a + b) }] };
  }
  if (name === "multiply") {
    return { content: [{ type: "text", text: String(a * b) }] };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
