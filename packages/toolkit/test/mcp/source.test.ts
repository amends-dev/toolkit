import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger, Schema, Stream } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import * as Mcp from "../../src/Mcp.ts"
import * as ToolSource from "../../src/ToolSource.ts"

const Echo = Tool.make("echo", {
  description: "Echoes the text",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})
  .annotate(Tool.Title, "Echo")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)

const Lookup = Tool.make("lookup", {
  description: "Looks an issue up",
  parameters: Schema.Struct({ id: Schema.Finite }),
  success: Schema.Struct({ id: Schema.Finite, title: Schema.String })
})

const Lock = Tool.make("lock", {
  parameters: Tool.EmptyParams,
  success: Schema.String,
  failure: Schema.String
})

const Explode = Tool.make("explode", { parameters: Tool.EmptyParams, success: Schema.String })

const AppToolkit = Toolkit.make(Echo, Lookup, Lock, Explode)

const appToolkitLayer = AppToolkit.toLayer({
  echo: ({ text }) => Effect.succeed(text),
  lookup: ({ id }) => Effect.succeed({ id, title: "Broken build" }),
  lock: () => Effect.fail("Issue 7 is locked"),
  explode: () => Effect.die("private defect at 10.0.3.7")
})

const serverLayer = (
  protocols: ReadonlyArray<McpProtocol.ProtocolAdapter>,
  moreTools: Layer.Layer<never, never, McpServer.McpServer> = Layer.empty
) =>
  Layer.mergeAll(McpServer.toolkit(AppToolkit).pipe(Layer.provide(appToolkitLayer)), moreTools).pipe(
    Layer.provide(
      McpServer.layerHttp({
        name: "everything",
        version: "1.0.0",
        path: "/mcp",
        protocols: protocols as [McpProtocol.ProtocolAdapter, ...Array<McpProtocol.ProtocolAdapter>]
      })
    ),
    Layer.provide(Logger.layer([]))
  )

interface Sent {
  readonly method: string
  readonly headers: Record<string, string>
}

/**
 * Serves the MCP server over the protocols given, in this process, and makes a source of it with an
 * HTTP client that adds `authorization`. `fault` answers a request instead of the server, when it
 * returns a response. `restart` replaces the server by a new one, which has none of the sessions.
 */
const serve = Effect.fnUntraced(function* (
  protocols: ReadonlyArray<McpProtocol.ProtocolAdapter>,
  options?: {
    readonly fault?: (request: Request) => Response | Promise<never> | undefined
    readonly moreTools?: Layer.Layer<never, never, McpServer.McpServer>
  }
) {
  const sent: Array<Sent> = []
  const start = () => HttpRouter.toWebHandler(serverLayer(protocols, options?.moreTools), { disableLogger: true })
  let current = start()
  yield* Effect.addFinalizer(() => Effect.promise(() => current.dispose()))

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const body = (await request.clone().json()) as { readonly method: string }
    sent.push({ method: body.method, headers: Object.fromEntries(request.headers) })
    return (options?.fault?.(request) as Response | undefined) ?? current.handler(request)
  }
  const fetch: typeof globalThis.fetch = Object.assign(fetchImpl, { preconnect() {} })

  const httpClient = yield* HttpClient.HttpClient.pipe(
    Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))))
  )
  const client = HttpClient.mapRequest(httpClient, HttpClientRequest.setHeader("authorization", "Bearer secret"))
  const source = yield* Mcp.http({ name: "everything", url: "http://localhost/mcp", client })

  const restart = Effect.promise(async () => {
    const old = current
    current = start()
    await old.dispose()
  })
  return { source, sent, restart }
})

const methods = (sent: ReadonlyArray<Sent>) => sent.map((request) => request.method)

const paramHeaders = (request: Sent | undefined) =>
  Object.fromEntries(Object.entries(request?.headers ?? {}).filter(([name]) => name.startsWith("mcp-param-")))

/** What `run_query` takes, which marks four of its parameters as headers, one of them below another. */
const queryInput = (regionHeader: string): McpSchema.ToolJson => ({
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": regionHeader },
    query: { type: "string" },
    shard: { type: "integer", "x-mcp-header": "Shard" },
    dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" },
    routing: { type: "object", properties: { zone: { type: "string", "x-mcp-header": "Zone" } } }
  },
  required: ["region", "query"]
})

/**
 * Tools of a server that marks parameters as headers, with the arguments of each call that reached
 * them, and a way to change what `run_query` takes while the server is up. The Effect AI server
 * refuses a call that has not the headers a tool marks, on the stateless protocol.
 */
const markedTools = () => {
  const received: Array<unknown> = []
  let register: ((inputSchema: McpSchema.ToolJson) => Effect.Effect<void>) | undefined
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer
      const handle = (payload: unknown) =>
        Effect.sync(() => {
          received.push(payload)
          return new McpSchema.CallToolResult({ content: [] })
        })
      register = (inputSchema) =>
        server.addTool({
          tool: new McpSchema.Tool({ name: "run_query", inputSchema }),
          annotations: Context.empty(),
          handle
        })
      yield* register(queryInput("Region"))
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: "café",
          inputSchema: { type: "object", properties: {} }
        }),
        annotations: Context.empty(),
        handle
      })
    })
  )
  const redefine = (inputSchema: McpSchema.ToolJson) =>
    register === undefined ? Effect.die("The server has not started") : register(inputSchema)
  return { layer, received, redefine }
}

describe.each([
  ["stateless", [McpProtocol.v2026_07_28]],
  ["with sessions", [McpProtocol.v2025_11_25]],
  ["either", [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25]]
] as const)("an MCP server that speaks %s", (_, protocols) => {
  it.effect("lists its tools as definitions, with the hints it gives", () =>
    Effect.gen(function* () {
      const { source } = yield* serve(protocols)

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.name).sort()).toEqual(["echo", "explode", "lock", "lookup"])
      const echo = definitions.find((definition) => definition.name === "echo")
      expect(echo?.description).toBe("Echoes the text")
      expect(echo?.inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      })
      expect(echo?.annotations).toMatchObject({ title: "Echo", readOnly: true, openWorld: false })
    })
  )

  it.effect("runs a tool and returns what the tool answers", () =>
    Effect.gen(function* () {
      const { source } = yield* serve(protocols)

      const echoed = yield* source.call("echo", { text: "hello" })
      const looked = yield* source.call("lookup", { id: 7 })

      expect(JSON.stringify(echoed)).toContain("hello")
      expect(JSON.stringify(looked)).toContain("Broken build")
    })
  )

  it.effect("fails a call for a tool that reports its failure, with what it said", () =>
    Effect.gen(function* () {
      const { source } = yield* serve(protocols)

      const error = yield* Effect.flip(source.call("lock", {}))

      expect(error.reason._tag).toBe("CallFailedError")
      expect(error.reason.message).toContain("Issue 7 is locked")
      expect(error.source).toBe("everything")
    })
  )

  it.effect("fails a call that the server rejects, without what only the server should know", () =>
    Effect.gen(function* () {
      const { source } = yield* serve(protocols)

      const rejected = yield* Effect.flip(source.call("echo", { text: 7 }))
      const exploded = yield* Effect.flip(source.call("explode", {}))

      // A server may say what is wrong with the input as a tool failure, which the model can read.
      expect(rejected.reason._tag).toBe("CallFailedError")
      expect(rejected.reason.modelMessage).toContain("text")
      expect(exploded.reason.modelMessage).not.toContain("10.0.3.7")
      expect(exploded.reason.message).not.toContain("10.0.3.7")
    })
  )

  it.effect("is the toolkit of a model, which reads a failed call as a result", () =>
    Effect.gen(function* () {
      const { source } = yield* serve(protocols)
      const toolkit = yield* ToolSource.toolkit(source, yield* source.discover)
      const call = (name: string, params: unknown) =>
        toolkit.handle(name, params).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.map((results) => results[results.length - 1])
        )

      const looked = yield* call("lookup", { id: 7 })
      const locked = yield* call("lock", {})

      expect(looked?.isFailure).toBe(false)
      expect(JSON.stringify(looked?.result)).toContain("Broken build")
      expect(locked?.isFailure).toBe(true)
      expect(locked?.result).toMatchObject({ code: "CallFailedError", retryable: false })
      expect(JSON.stringify(locked?.result)).toContain("Issue 7 is locked")
    })
  )
})

describe("the way a source finds to speak to a server", () => {
  it.effect("speaks statelessly to a server that can, with no session to start", () =>
    Effect.gen(function* () {
      const { source, sent } = yield* serve([McpProtocol.v2026_07_28, McpProtocol.v2025_11_25])

      yield* source.call("echo", { text: "hello" })

      expect(methods(sent)).toEqual(["server/discover", "tools/call"])
      expect(sent[1]?.headers["mcp-method"]).toBe("tools/call")
      expect(sent[1]?.headers["mcp-name"]).toBe("echo")
      expect(sent[1]?.headers["mcp-protocol-version"]).toBe("2026-07-28")
      expect(sent[1]?.headers["mcp-session-id"]).toBeUndefined()
    })
  )

  it.effect("starts a session with a server that has them, and keeps to it", () =>
    Effect.gen(function* () {
      const { source, sent } = yield* serve([McpProtocol.v2025_11_25])

      yield* source.call("echo", { text: "one" })
      yield* source.call("echo", { text: "two" })

      expect(methods(sent)).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/call"
      ])
      const sessionId = sent[3]?.headers["mcp-session-id"]
      expect(sessionId).toBeTruthy()
      expect(sent[4]?.headers["mcp-session-id"]).toBe(sessionId)
      expect(sent[3]?.headers["mcp-protocol-version"]).toBe("2025-11-25")
    })
  )

  it.effect("settles once for requests that begin together", () =>
    Effect.gen(function* () {
      const { source, sent } = yield* serve([McpProtocol.v2025_11_25])

      yield* Effect.all([source.call("echo", { text: "a" }), source.call("echo", { text: "b" }), source.discover], {
        concurrency: "unbounded"
      })

      expect(methods(sent).filter((method) => method === "initialize")).toHaveLength(1)
    })
  )

  it.effect("starts another session when the server has ended the one it had", () =>
    Effect.gen(function* () {
      const { source, sent, restart } = yield* serve([McpProtocol.v2025_11_25])
      yield* source.call("echo", { text: "before" })

      yield* restart
      const echoed = yield* source.call("echo", { text: "after" })

      expect(JSON.stringify(echoed)).toContain("after")
      expect(methods(sent).filter((method) => method === "initialize")).toHaveLength(2)
    })
  )

  it.effect("reaches a server that asks for credentials only with the client's", () =>
    Effect.gen(function* () {
      const { source } = yield* serve([McpProtocol.v2026_07_28], {
        fault: (request) =>
          request.headers.get("authorization") === "Bearer secret" ? undefined : new Response("", { status: 401 })
      })

      expect(yield* source.discover).toHaveLength(4)
    })
  )
})

describe("a server that cannot be used", () => {
  it.effect("is one the source is not let in to", () =>
    Effect.gen(function* () {
      const { source } = yield* serve([McpProtocol.v2026_07_28], {
        fault: () => new Response("", { status: 401 })
      })

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("AuthenticationError")
    })
  )

  it.effect("is one that is down, which may be tried again", () =>
    Effect.gen(function* () {
      const { source } = yield* serve([McpProtocol.v2026_07_28], {
        fault: () => new Response("", { status: 503 })
      })

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.isRetryable).toBe(true)
    })
  )

  it.effect("is one that cannot be reached", () =>
    Effect.gen(function* () {
      const { source } = yield* serve([McpProtocol.v2026_07_28], {
        fault: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.3.7:8443"))
      })

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.reason.modelMessage).not.toContain("10.0.3.7")
    })
  )
})

describe("a tool that has parameters sent as headers too", () => {
  const stateless = [McpProtocol.v2026_07_28]
  const call = {
    region: "us-west1",
    query: "select 1",
    shard: 7,
    dryRun: false,
    routing: { zone: "a" }
  }

  it.effect("is called with the headers when the source has listed the tools", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })
      yield* source.discover
      sent.length = 0

      yield* source.call("run_query", call)

      expect(methods(sent)).toEqual(["tools/call"])
      expect(paramHeaders(sent[0])).toEqual({
        "mcp-param-region": "us-west1",
        "mcp-param-shard": "7",
        "mcp-param-dry-run": "false",
        "mcp-param-zone": "a"
      })
      expect(tools.received).toEqual([call])
    })
  )

  it.effect("is called again with the headers when the server refuses a call without them", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })

      yield* source.call("run_query", call)

      expect(methods(sent)).toEqual(["server/discover", "tools/call", "tools/list", "tools/call"])
      expect(paramHeaders(sent[1])).toEqual({})
      expect(Object.keys(paramHeaders(sent[3])).sort()).toEqual([
        "mcp-param-dry-run",
        "mcp-param-region",
        "mcp-param-shard",
        "mcp-param-zone"
      ])
      // The server refused the first before it ran the tool.
      expect(tools.received).toEqual([call])

      sent.length = 0
      yield* source.call("run_query", call)

      expect(methods(sent)).toEqual(["tools/call"])
      expect(Object.keys(paramHeaders(sent[0]))).toHaveLength(4)
    })
  )

  it.effect("is called with the headers the server asks for now, when it has changed them", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })
      yield* source.discover
      yield* tools.redefine(queryInput("Area"))
      sent.length = 0

      yield* source.call("run_query", call)

      expect(methods(sent)).toEqual(["tools/call", "tools/list", "tools/call"])
      expect(paramHeaders(sent[0])["mcp-param-region"]).toBe("us-west1")
      expect(paramHeaders(sent[2])["mcp-param-area"]).toBe("us-west1")
      expect(paramHeaders(sent[2])["mcp-param-region"]).toBeUndefined()
      expect(tools.received).toEqual([call])
    })
  )

  it.effect("has the headers only of the parameters that the call gives", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })
      yield* source.discover
      sent.length = 0

      yield* source.call("run_query", { region: "eu", query: "select 1" })

      expect(paramHeaders(sent[0])).toEqual({ "mcp-param-region": "eu" })
    })
  )

  // The server decodes a header that has to be base64 and compares it with the body.
  it.effect.each(["Région 世界", " padded ", "a\tb", "=?base64?x?=", "us west 1", "", "eu\r\nx-evil: 1"])(
    "is called with %j for a parameter, which the server reads as it is",
    (region) =>
      Effect.gen(function* () {
        const tools = markedTools()
        const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })
        yield* source.discover
        sent.length = 0

        yield* source.call("run_query", { region, query: "select 1" })

        expect(methods(sent)).toEqual(["tools/call"])
        expect(tools.received).toEqual([{ region, query: "select 1" }])
      })
  )

  it.effect("is named in a header, even when the name is not ASCII", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve(stateless, { moreTools: tools.layer })
      yield* source.discover
      sent.length = 0

      yield* source.call("café", {})

      expect(sent[0]?.headers["mcp-name"]).toBe("=?base64?Y2Fmw6k=?=")
      expect(tools.received).toEqual([{}])
    })
  )

  it.effect("is left out of the tools, and the leaving out is logged, when its marks are wrong", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source } = yield* serve(stateless, { moreTools: tools.layer })
      yield* tools.redefine(queryInput("My Region"))
      const logged: Array<string> = []
      const log = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") logged.push(JSON.stringify(options.message))
      })

      const definitions = yield* source.discover.pipe(Effect.provide(Logger.layer([log])))

      expect(definitions.map((definition) => definition.name)).not.toContain("run_query")
      expect(definitions.map((definition) => definition.name)).toContain("echo")
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain("run_query")
      expect(logged[0]).toContain("My Region")
    })
  )

  it.effect("keeps the marks in its definition, as the server wrote them", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source } = yield* serve(stateless, { moreTools: tools.layer })

      const definitions = yield* source.discover

      const query = definitions.find((definition) => definition.name === "run_query")
      expect(query?.inputSchema).toMatchObject({
        properties: { region: { "x-mcp-header": "Region" } }
      })
    })
  )

  it.effect("is called with no headers, and is not left out, by a server that has sessions", () =>
    Effect.gen(function* () {
      const tools = markedTools()
      const { source, sent } = yield* serve([McpProtocol.v2025_11_25], {
        moreTools: tools.layer
      })
      yield* tools.redefine(queryInput("My Region"))

      const definitions = yield* source.discover
      yield* source.call("run_query", call)

      expect(definitions.map((definition) => definition.name)).toContain("run_query")
      expect(sent.some((request) => Object.keys(paramHeaders(request)).length > 0)).toBe(false)
      expect(tools.received).toEqual([call])
    })
  )
})
