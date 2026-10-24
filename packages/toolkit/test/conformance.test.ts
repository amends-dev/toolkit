import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { McpProtocol } from "effect/ai"
import { run } from "../src/conformance/index.ts"
import type { Fixture, Subject } from "../src/conformance/index.ts"
import * as Http from "../src/Http.ts"
import * as Mcp from "../src/Mcp.ts"
import * as OpenApi from "../src/OpenApi.ts"
import { authenticatedClient, serveApi, serveMcp } from "./conformance-servers.ts"

/** The MCP source, over Effect AI's own MCP server in this process, speaking `protocols`. */
const mcpFixture = (
  protocols: readonly [McpProtocol.ProtocolAdapter, ...Array<McpProtocol.ProtocolAdapter>]
): Fixture<unknown> => ({
  make: Effect.fnUntraced(function* (condition) {
    const { client, started, secrets } = yield* serveMcp(protocols, condition)
    const source = yield* Mcp.http({ name: "fixture", url: "http://localhost/mcp", client })
    return { source, blockedCallStarted: started, secrets } satisfies Subject
  }),
  tools: {
    echo: { tool: "echo", input: (text) => ({ text }), invalidInput: { text: 7 } },
    failing: { tool: "failing", input: {} },
    blocking: { tool: "blocking", input: {} }
  }
})

/** What an HTTP API's tools take: each is a request, and `echo` has its input in the body. */
const httpTools: Fixture<unknown>["tools"] = {
  echo: {
    tool: "echo",
    input: (text) => ({ body: { text } }),
    invalidInput: { body: { text: 7 } }
  },
  failing: { tool: "failing", input: {} },
  blocking: { tool: "blocking", input: {} }
}

/** The HTTP source over operations written by hand. */
const httpFixture: Fixture<unknown> = {
  make: Effect.fnUntraced(function* (condition) {
    const { baseUrl, started, secrets } = yield* serveApi(condition)
    const source = yield* Http.make({
      name: "fixture",
      baseUrl,
      client: yield* authenticatedClient(),
      operations: [
        {
          definition: {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"]
                }
              },
              required: ["body"],
              additionalProperties: false
            },
            annotations: {}
          },
          request: { method: "POST", path: "/echo", parameters: [], body: "body" }
        },
        {
          definition: {
            name: "failing",
            inputSchema: { type: "object", additionalProperties: false },
            annotations: {}
          },
          request: { method: "POST", path: "/fail", parameters: [] }
        },
        {
          definition: {
            name: "blocking",
            inputSchema: { type: "object", additionalProperties: false },
            annotations: {}
          },
          request: { method: "GET", path: "/block", parameters: [] }
        }
      ]
    })
    return { source, blockedCallStarted: started, secrets } satisfies Subject
  }),
  tools: httpTools
}

/** The HTTP source over the operations that OpenAPI document of the same API gives. */
const openApiFixture: Fixture<unknown> = {
  make: Effect.fnUntraced(function* (condition) {
    const { baseUrl, started, secrets } = yield* serveApi(condition)
    const { operations } = yield* OpenApi.readOperations({
      openapi: "3.1.0",
      info: { title: "Fixture", version: "1" },
      paths: {
        "/echo": {
          post: {
            operationId: "echo",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"]
                  }
                }
              }
            }
          }
        },
        "/fail": { post: { operationId: "failing" } },
        "/block": { get: { operationId: "blocking" } }
      }
    })
    const source = yield* Http.make({
      name: "fixture",
      baseUrl,
      client: yield* authenticatedClient(),
      operations
    })
    return { source, blockedCallStarted: started, secrets } satisfies Subject
  }),
  tools: httpTools
}

describe("the MCP source over a server that speaks the stateless protocol", () => {
  run(mcpFixture([McpProtocol.v2026_07_28]))
})

describe("the MCP source over a server that speaks with sessions", () => {
  run(mcpFixture([McpProtocol.v2025_11_25]))
})

describe("the HTTP source over operations written by hand", () => {
  run(httpFixture)
})

describe("the HTTP source over the operations of an OpenAPI document", () => {
  run(openApiFixture)
})
