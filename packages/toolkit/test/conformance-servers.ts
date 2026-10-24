/**
 * The systems the conformance suites run sources against. Each serves the fixture's three tools:
 * `echo`, which answers with the text it is given, `failing`, which reports that it failed, and
 * `blocking`, which does not answer. Each is started for one test, in the condition the suite asks
 * for, and stopped when the test ends.
 */

import { Effect, Layer, Logger, Schema } from "effect"
import { McpServer, Tool, Toolkit, type McpProtocol } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import type { Condition } from "../src/conformance/index.ts"

/** What a source holds, which it must not tell a model. */
export const token = "s3cr3t-token-4f2a"

/** An HTTP client that sends `token` as its credential. */
export const authenticatedClient = (fetch?: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    const layer =
      fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(layer))
    return HttpClient.mapRequest(client, HttpClientRequest.setHeader("authorization", `Bearer ${token}`))
  })

/** A promise, and the function that settles it, for a system to say a call reached it. */
const signal = () => {
  let settle = () => {}
  const settled = new Promise<void>((resolve) => (settle = resolve))
  return { settle, started: Effect.promise(() => settled) }
}

/** An HTTP API with `POST /echo`, `POST /fail`, and `GET /block`, that answers JSON. */
export const serveApi = Effect.fnUntraced(function* (condition: Condition) {
  const { settle, started } = signal()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        async fetch(request) {
          if (condition === "unauthorized") return new Response("", { status: 401 })
          if (condition === "unavailable") return new Response("Traceback: db at 10.0.3.7", { status: 503 })
          const { pathname } = new URL(request.url)
          if (request.method === "POST" && pathname === "/echo") {
            const body = (await request.json()) as { readonly text?: unknown }
            return typeof body.text === "string"
              ? Response.json({ echoed: body.text })
              : Response.json({ message: "text must be a string" }, { status: 400 })
          }
          if (request.method === "POST" && pathname === "/fail") {
            return Response.json({ message: "Issue 7 is locked" }, { status: 422 })
          }
          if (request.method === "GET" && pathname === "/block") {
            settle()
            return new Promise<Response>(() => {})
          }
          return new Response("", { status: 404 })
        }
      })
    ),
    (server) => Effect.promise(() => server.stop(true))
  )
  const baseUrl = `http://localhost:${server.port}`
  // A system that cannot be reached is a port where nothing listens any more.
  if (condition === "unreachable") yield* Effect.promise(() => server.stop(true))
  return { baseUrl, started, secrets: [token, baseUrl, `localhost:${server.port}`] }
})

const Echo = Tool.make("echo", {
  description: "Answers with the text it is given",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const Failing = Tool.make("failing", {
  description: "Reports that it failed",
  parameters: Tool.EmptyParams,
  success: Schema.String,
  failure: Schema.String
})

const Blocking = Tool.make("blocking", {
  description: "Does not answer",
  parameters: Tool.EmptyParams,
  success: Schema.String
})

/**
 * An MCP server with `echo`, `failing`, and `blocking`, over the protocols given, behind a `fetch`
 * that the source reaches it with and that answers as the condition says.
 */
export const serveMcp = Effect.fnUntraced(function* (
  protocols: readonly [McpProtocol.ProtocolAdapter, ...Array<McpProtocol.ProtocolAdapter>],
  condition: Condition
) {
  const { settle, started } = signal()
  const tools = Toolkit.make(Echo, Failing, Blocking)
  const layer = McpServer.toolkit(tools).pipe(
    Layer.provide(
      tools.toLayer({
        echo: ({ text }) => Effect.succeed(text),
        failing: () => Effect.fail("Issue 7 is locked"),
        blocking: () => Effect.sync(settle).pipe(Effect.andThen(Effect.never))
      })
    ),
    Layer.provide(McpServer.layerHttp({ name: "fixture", version: "1.0.0", path: "/mcp", protocols })),
    Layer.provide(Logger.layer([]))
  )
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))

  const serve = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (condition === "unauthorized") return new Response("", { status: 401 })
    if (condition === "unavailable") return new Response("Traceback: db at 10.0.3.7", { status: 503 })
    if (condition === "unreachable") throw new TypeError("connect ECONNREFUSED 10.0.3.7:8443")
    return handler(input instanceof Request ? input : new Request(String(input), init))
  }
  const fetch: typeof globalThis.fetch = Object.assign(serve, { preconnect() {} })
  return { client: yield* authenticatedClient(fetch), started, secrets: [token, "10.0.3.7"] }
})
