import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Mcp from "../../src/Mcp.ts"

interface Call {
  readonly id: number | undefined
  readonly method: string
  readonly params: Record<string, unknown>
  readonly headers: Record<string, string>
}

/** What the scripted server sends back, as the wire has it. */
interface Answer {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string
}

const ok = (call: Call, result: unknown): Answer => ({
  body: JSON.stringify({ jsonrpc: "2.0", id: call.id, result })
})

const rpcError = (call: Call, code: number, message: string): Answer => ({
  body: JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code, message } })
})

/** A reply that is a stream of events, each of which is the data of one. */
const events = (...data: ReadonlyArray<unknown>): Answer => ({
  headers: { "content-type": "text/event-stream" },
  body: data.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`).join("")
})

/** Answers what `script` says to each request, and records what was asked. */
const scripted = (script: (call: Call) => Answer) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const sent = (request.body as { readonly body?: Uint8Array }).body
      const message = JSON.parse(new TextDecoder().decode(sent)) as {
        readonly id?: number
        readonly method: string
        readonly params?: Record<string, unknown>
      }
      const call: Call = {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
        headers: { ...request.headers }
      }
      calls.push(call)
      const answer = script(call)
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.body ?? "", {
          status: answer.status ?? 200,
          headers: answer.headers ?? {}
        })
      )
    })
  )
  return { client, calls }
}

/** A server of the stateless protocol, which `handle` answers for. */
const stateless = (handle: (call: Call) => Answer) => (call: Call) =>
  call.method === "server/discover" ? ok(call, { supportedVersions: ["2026-07-28"] }) : handle(call)

const connect = (client: HttpClient.HttpClient) => Mcp.http({ name: "wire", url: "http://localhost/mcp", client })

const tool = (name: string) => ({ name, inputSchema: { type: "object" } })

describe("who the source says it is", () => {
  const clientInfo = { name: "tests", version: "9.9.9" }

  it.effect("is told in every request to a stateless server, as the caller named it", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(stateless((call) => ok(call, { tools: [] })))
      const source = yield* Mcp.http({
        name: "wire",
        url: "http://localhost/mcp",
        client,
        clientInfo
      })

      yield* source.discover

      expect(
        calls.map((call) => (call.params["_meta"] as Record<string, unknown>)["io.modelcontextprotocol/clientInfo"])
      ).toEqual([clientInfo, clientInfo])
    })
  )

  it.effect("is told when a session starts, and is amends when the caller named nobody", () =>
    Effect.gen(function* () {
      const server = (call: Call): Answer =>
        call.method === "server/discover"
          ? rpcError(call, -32601, "Method not found")
          : call.method === "initialize"
            ? ok(call, { protocolVersion: "2025-11-25", capabilities: {} })
            : call.method === "notifications/initialized"
              ? { status: 202 }
              : ok(call, { tools: [] })
      const named = scripted(server)
      const unnamed = scripted(server)

      yield* (yield* Mcp.http({
        name: "wire",
        url: "http://localhost/mcp",
        client: named.client,
        clientInfo
      })).discover
      yield* (yield* connect(unnamed.client)).discover

      const initializing = (calls: ReadonlyArray<Call>) =>
        calls.find((call) => call.method === "initialize")?.params["clientInfo"]
      expect(initializing(named.calls)).toEqual(clientInfo)
      expect(initializing(unnamed.calls)).toEqual({ name: "amends", version: "0.0.0" })
    })
  )
})

describe("the tools an MCP server lists", () => {
  it.effect("are all of them, over the pages it lists them in", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        stateless((call) =>
          call.params["cursor"] === undefined
            ? ok(call, { tools: [tool("one")], nextCursor: "next" })
            : ok(call, { tools: [tool("two")] })
        )
      )
      const source = yield* connect(client)

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.name)).toEqual(["one", "two"])
      expect(calls.map((call) => call.params["cursor"])).toEqual([undefined, undefined, "next"])
    })
  )

  it.effect("are given the title the server gives them, from their annotations first", () =>
    Effect.gen(function* () {
      const { client } = scripted(
        stateless((call) =>
          ok(call, {
            tools: [
              { ...tool("plain"), title: "Plain" },
              { ...tool("hinted"), title: "Hinted", annotations: { title: "From the hints" } },
              tool("untitled")
            ]
          })
        )
      )
      const source = yield* connect(client)

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.annotations.title)).toEqual([
        "Plain",
        "From the hints",
        undefined
      ])
    })
  )

  it.effect("are not all there is when the server never ends the list", () =>
    Effect.gen(function* () {
      const { client } = scripted(stateless((call) => ok(call, { tools: [tool("one")], nextCursor: "again" })))
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("InvalidResponseError")
    })
  )

  it.effect("are refused when the server lists one that is not as a tool is", () =>
    Effect.gen(function* () {
      const { client } = scripted(
        stateless((call) => ok(call, { tools: [{ name: "one", inputSchema: { type: "string" } }] }))
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("InvalidResponseError")
    })
  )
})

describe("what a tool answers", () => {
  const callWith = (answer: (call: Call) => Answer) =>
    Effect.gen(function* () {
      const { client } = scripted(stateless(answer))
      const source = yield* connect(client)
      return yield* source.call("tool", {})
    })

  it.effect("is its structured content when it has some, and else its content blocks", () =>
    Effect.gen(function* () {
      const structured = yield* callWith((call) =>
        ok(call, {
          content: [{ type: "text", text: '{"sum":5}' }],
          structuredContent: { sum: 5 }
        })
      )
      const unstructured = yield* callWith((call) => ok(call, { content: [{ type: "text", text: "hello" }] }))
      const bare = yield* callWith((call) => ok(call, { structuredContent: "plain" }))

      expect(structured).toEqual({ sum: 5 })
      expect(unstructured).toEqual([{ type: "text", text: "hello" }])
      expect(bare).toBe("plain")
    })
  )

  it.effect("is a failed call, with the text the tool said, when the tool reports a failure", () =>
    Effect.gen(function* () {
      const said = yield* Effect.flip(
        callWith((call) =>
          ok(call, {
            isError: true,
            content: [
              { type: "text", text: "Issue 7 is locked" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
              { type: "text", text: "Ask the owner" }
            ]
          })
        )
      )
      const silent = yield* Effect.flip(callWith((call) => ok(call, { isError: true })))

      expect(said.reason._tag).toBe("CallFailedError")
      expect(said.reason.message).toBe("Issue 7 is locked\nAsk the owner")
      expect(silent.reason.message).toBe("The tool reported a failure")
    })
  )

  it.effect("is not supported when the tool asks for input before it can answer", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        callWith((call) => ok(call, { resultType: "input_required", inputRequests: { name: { method: "elicit" } } }))
      )

      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("is found among the events of a reply that is a stream, whatever else is sent", () =>
    Effect.gen(function* () {
      const answered = yield* callWith((call) =>
        events(
          "",
          { jsonrpc: "2.0", method: "notifications/message", params: { data: "working" } },
          { jsonrpc: "2.0", id: 99, method: "ping" },
          { jsonrpc: "2.0", id: 1234, result: { structuredContent: "someone else's" } },
          "not json",
          { jsonrpc: "2.0", id: call.id, result: { structuredContent: "mine" } }
        )
      )

      expect(answered).toBe("mine")
    })
  )

  it.effect("is missing when a stream of events ends without the reply", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(callWith(() => events({ jsonrpc: "2.0", method: "notifications/message" })))

      expect(error.reason._tag).toBe("InvalidResponseError")
    })
  )

  it.effect("is not as expected when it is not JSON, or not a result of the shape", () =>
    Effect.gen(function* () {
      const text = yield* Effect.flip(callWith(() => ({ body: "<html>" })))
      const shape = yield* Effect.flip(callWith((call) => ok(call, { content: "not blocks", isError: "yes" })))

      expect(text.reason._tag).toBe("InvalidResponseError")
      expect(shape.reason._tag).toBe("InvalidResponseError")
    })
  )
})

describe("a failure of a request", () => {
  const failWith = (
    answer: Answer | ((call: Call) => Answer),
    around: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client
  ) =>
    Effect.gen(function* () {
      const { client } = scripted(stateless(typeof answer === "function" ? answer : () => answer))
      const source = yield* connect(around(client))
      return yield* Effect.flip(source.call("tool", {}))
    })

  it.effect("is read by the code of the error the server reports", () =>
    Effect.gen(function* () {
      const reasons = []
      for (const code of [-32602, -32601, -32600, -32700, -32020, -32603, -32000]) {
        const { client } = scripted(stateless((call) => rpcError(call, code, "Said by the server")))
        const source = yield* connect(client)
        const error = yield* Effect.flip(source.call("tool", {}))
        reasons.push([code, error.reason._tag, error.reason.message])
      }

      expect(reasons).toEqual([
        [-32602, "InvalidInputError", "Said by the server"],
        [-32601, "UnsupportedError", "Said by the server"],
        [-32600, "UnsupportedError", "Said by the server"],
        [-32700, "UnsupportedError", "Said by the server"],
        [-32020, "UnsupportedError", "Said by the server"],
        [-32603, "UnknownError", "Said by the server"],
        [-32000, "UnknownError", "Said by the server"]
      ])
    })
  )

  it.effect("is read by the status of the response when it says nothing else", () =>
    Effect.gen(function* () {
      const reasons = []
      for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
        const error = yield* failWith({ status })
        reasons.push([status, error.reason._tag, error.isRetryable])
      }

      expect(reasons).toEqual([
        [400, "UnsupportedError", false],
        [401, "AuthenticationError", false],
        [403, "AuthenticationError", false],
        [404, "UnsupportedError", false],
        [408, "UnavailableError", true],
        [429, "UnavailableError", true],
        [500, "UnavailableError", true],
        [503, "UnavailableError", true]
      ])
    })
  )

  it.effect("is read the same when the client rejects the statuses it does not accept", () =>
    Effect.gen(function* () {
      const refused = yield* failWith({ status: 401 }, HttpClient.filterStatusOk)
      const down = yield* failWith({ status: 503 }, HttpClient.filterStatusOk)

      expect(refused.reason._tag).toBe("AuthenticationError")
      expect(down.reason._tag).toBe("UnavailableError")
    })
  )

  it.effect("is read by what the server reports, even when its status is an error", () =>
    Effect.gen(function* () {
      const error = yield* failWith((call) => ({
        status: 400,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32602, message: "No such thing" }
        })
      }))

      expect(error.reason._tag).toBe("InvalidInputError")
      expect(error.reason.message).toBe("No such thing")
    })
  )

  it.effect("is read by what the server reports even when it cannot say which request failed", () =>
    Effect.gen(function* () {
      const error = yield* failWith({
        status: 400,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "No session" }
        })
      })

      expect(error.reason._tag).toBe("UnknownError")
      expect(error.reason.message).toBe("No session")
    })
  )
})

describe("a server with sessions", () => {
  /** An older server: it does not know `server/discover`, and gives `session` to `initialize`. */
  const withSessions =
    (options: { readonly session?: string; readonly version?: string }, handle: (call: Call) => Answer) =>
    (call: Call): Answer => {
      switch (call.method) {
        case "server/discover":
          return rpcError(call, -32601, "Method not found")
        case "initialize":
          return {
            ...ok(call, { protocolVersion: options.version ?? "2025-06-18", capabilities: {} }),
            headers: options.session === undefined ? {} : { "mcp-session-id": options.session }
          }
        case "notifications/initialized":
          return { status: 202 }
        default:
          return handle(call)
      }
    }

  it.effect("is spoken to in the protocol version it chose, with the session it gave", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        withSessions({ session: "abc", version: "2025-06-18" }, (call) => ok(call, { tools: [] }))
      )
      const source = yield* connect(client)

      yield* source.discover

      expect(calls.map((call) => call.method)).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/list"
      ])
      expect(calls[2]?.headers["mcp-session-id"]).toBe("abc")
      expect(calls[3]?.headers["mcp-session-id"]).toBe("abc")
      expect(calls[3]?.headers["mcp-protocol-version"]).toBe("2025-06-18")
      expect(calls[3]?.headers["mcp-method"]).toBeUndefined()
      expect(calls[3]?.params["_meta"]).toBeUndefined()
    })
  )

  it.effect("is spoken to without a session when it gives none", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(withSessions({}, (call) => ok(call, { tools: [] })))
      const source = yield* connect(client)

      yield* source.discover

      expect(calls.at(-1)?.headers["mcp-session-id"]).toBeUndefined()
    })
  )

  it.effect("is not spoken to when it chooses a version the source does not speak", () =>
    Effect.gen(function* () {
      const { client } = scripted(withSessions({ version: "1999-01-01" }, (call) => ok(call, { tools: [] })))
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("is not trusted to be there when it ends every session it starts", () =>
    Effect.gen(function* () {
      const { client } = scripted(
        withSessions({ session: "abc" }, (call) =>
          call.headers["mcp-session-id"] === undefined ? ok(call, { tools: [] }) : { status: 404 }
        )
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("UnavailableError")
    })
  )

  it.effect("is not spoken to when it refuses to be told the session has begun", () =>
    Effect.gen(function* () {
      const { client } = scripted((call) =>
        call.method === "notifications/initialized"
          ? { status: 503 }
          : withSessions({ session: "abc" }, (call) => ok(call, { tools: [] }))(call)
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("UnavailableError")
    })
  )

  it.effect("is not asked to start a session when the source is not let in", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(() => ({ status: 401 }))
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.discover)

      expect(error.reason._tag).toBe("AuthenticationError")
      expect(calls.map((call) => call.method)).toEqual(["server/discover"])
    })
  )
})

describe("a call that a server refuses for its headers", () => {
  const marking = (header: string) => ({
    name: "run",
    inputSchema: {
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": header } }
    }
  })
  const paramHeaders = (call: Call | undefined) =>
    Object.fromEntries(Object.entries(call?.headers ?? {}).filter(([n]) => n.startsWith("mcp-param-")))
  const methodsOf = (calls: ReadonlyArray<Call>) => calls.map((call) => call.method)

  /** A server that runs `run` only for a call that has the header it marks, and refuses it otherwise. */
  const requiring =
    (header: string, options?: { readonly status?: number }) =>
    (call: Call): Answer => {
      if (call.method === "tools/list") return ok(call, { tools: [marking(header)] })
      if (call.headers[`mcp-param-${header.toLowerCase()}`] !== undefined) return ok(call, {})
      return {
        ...rpcError(call, -32020, "Header mismatch"),
        ...(options?.status === undefined ? {} : { status: options.status })
      }
    }

  it.effect.each([200, 400])("is sent again with the headers the tools mark, for a %s", (status) =>
    Effect.gen(function* () {
      const { client, calls } = scripted(stateless(requiring("Region", { status })))
      const source = yield* connect(client)

      const result = yield* source.call("run", { region: "eu" })

      expect(result).toEqual([])
      expect(methodsOf(calls)).toEqual(["server/discover", "tools/call", "tools/list", "tools/call"])
      expect(paramHeaders(calls[1])).toEqual({})
      expect(paramHeaders(calls[3])).toEqual({ "mcp-param-region": "eu" })
    })
  )

  it.effect("is sent with the headers at once, by a source that has listed the tools", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(stateless(requiring("Region")))
      const source = yield* connect(client)
      yield* source.discover
      calls.length = 0

      yield* source.call("run", { region: "eu" })
      yield* source.call("run", { region: "us" })

      expect(methodsOf(calls)).toEqual(["tools/call", "tools/call"])
      expect(paramHeaders(calls[1])).toEqual({ "mcp-param-region": "us" })
    })
  )

  it.effect("is sent no more than twice, if the server refuses what it asked for", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        stateless((call) =>
          call.method === "tools/list"
            ? ok(call, { tools: [marking("Region")] })
            : rpcError(call, -32020, "Header mismatch")
        )
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(methodsOf(calls)).toEqual(["server/discover", "tools/call", "tools/list", "tools/call"])
      expect(error.reason._tag).toBe("UnsupportedError")
      expect(error.reason.message).toContain("Header mismatch")
    })
  )

  it.effect("is not sent again when the tools do not change the headers it was sent with", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        stateless((call) =>
          call.method === "tools/list" ? ok(call, { tools: [tool("run")] }) : rpcError(call, -32020, "Header mismatch")
        )
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(methodsOf(calls)).toEqual(["server/discover", "tools/call", "tools/list"])
      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("is not sent again when it was sent with the headers the tools mark already", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        stateless((call) =>
          call.method === "tools/list"
            ? ok(call, { tools: [marking("Region")] })
            : rpcError(call, -32020, "Header mismatch")
        )
      )
      const source = yield* connect(client)
      yield* source.discover
      calls.length = 0

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(methodsOf(calls)).toEqual(["tools/call", "tools/list"])
      expect(paramHeaders(calls[0])).toEqual({ "mcp-param-region": "eu" })
      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("fails as the listing of the tools fails, when the server cannot give them", () =>
    Effect.gen(function* () {
      const { client } = scripted(
        stateless((call) =>
          call.method === "tools/list" ? { status: 503 } : rpcError(call, -32020, "Header mismatch")
        )
      )
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(error.reason._tag).toBe("UnavailableError")
    })
  )

  it.effect("is read by the code -32020 alone, and no other code asks for the tools", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(stateless((call) => rpcError(call, -32001, "Header mismatch")))
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(methodsOf(calls)).toEqual(["server/discover", "tools/call"])
      expect(error.reason._tag).toBe("UnknownError")
    })
  )

  it.effect("is not sent again over a session, which has no headers to send", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted((call) => {
        switch (call.method) {
          case "server/discover":
            return rpcError(call, -32601, "Method not found")
          case "initialize":
            return {
              ...ok(call, { protocolVersion: "2025-11-25", capabilities: {} }),
              headers: { "mcp-session-id": "abc" }
            }
          case "notifications/initialized":
            return { status: 202 }
          default:
            return rpcError(call, -32020, "Header mismatch")
        }
      })
      const source = yield* connect(client)

      const error = yield* Effect.flip(source.call("run", { region: "eu" }))

      expect(methodsOf(calls).filter((method) => method === "tools/list")).toEqual([])
      expect(methodsOf(calls).filter((method) => method === "tools/call")).toHaveLength(1)
      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("is sent with the header named as the tools mark it, in the case of a header name", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(stateless(requiring("Shard-ID")))
      const source = yield* connect(client)
      yield* source.discover
      calls.length = 0

      yield* source.call("run", { region: "eu" })

      expect(paramHeaders(calls[0])).toEqual({ "mcp-param-shard-id": "eu" })
    })
  )
})

describe("the tools of a stateless server that mark their parameters", () => {
  const marking = (name: string, header: unknown, type: unknown = "string") => ({
    name,
    inputSchema: {
      type: "object",
      properties: { region: { type, "x-mcp-header": header } }
    }
  })

  it.effect("are left out of the listing when a mark is not one the protocol allows", () =>
    Effect.gen(function* () {
      const { client } = scripted(
        stateless((call) =>
          ok(call, {
            tools: [
              marking("good", "Region"),
              marking("spaced", "My Region"),
              marking("empty", ""),
              marking("object", "Region", "object"),
              tool("plain")
            ]
          })
        )
      )
      const source = yield* connect(client)

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.name)).toEqual(["good", "plain"])
    })
  )

  it.effect("are left in the listing of a server with sessions, which sends no headers", () =>
    Effect.gen(function* () {
      const { client } = scripted((call) => {
        switch (call.method) {
          case "server/discover":
            return rpcError(call, -32601, "Method not found")
          case "initialize":
            return ok(call, { protocolVersion: "2025-11-25", capabilities: {} })
          case "notifications/initialized":
            return { status: 202 }
          default:
            return ok(call, { tools: [marking("spaced", "My Region")] })
        }
      })
      const source = yield* connect(client)

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.name)).toEqual(["spaced"])
    })
  )

  it.effect("are called without headers when the server no longer lists them", () =>
    Effect.gen(function* () {
      const { client, calls } = scripted(
        stateless((call) =>
          call.method === "tools/list" ? ok(call, { tools: [marking("spaced", "My Region")] }) : ok(call, {})
        )
      )
      const source = yield* connect(client)
      yield* source.discover
      calls.length = 0

      yield* source.call("spaced", { region: "eu" })

      expect(calls.map((call) => call.method)).toEqual(["tools/call"])
      expect(Object.keys(calls[0]?.headers ?? {}).filter((n) => n.startsWith("mcp-param-"))).toEqual([])
    })
  )
})

describe("limits", () => {
  /** A server that answers everything but a call of a tool, which it never answers. */
  const neverCalls = () => {
    const client = HttpClient.make((request) => {
      const sent = (request.body as { readonly body?: Uint8Array }).body
      const message = JSON.parse(new TextDecoder().decode(sent)) as { readonly id?: number; readonly method: string }
      if (message.method === "tools/call") return Effect.never
      const result =
        message.method === "server/discover" ? { supportedVersions: ["2026-07-28"] } : { tools: [tool("slow")] }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })))
      )
    })
    return client
  }

  it.effect("fails a request the server does not answer within a minute by default, as unavailable", () =>
    Effect.gen(function* () {
      const source = yield* connect(HttpClient.make(() => Effect.never))
      const running = yield* Effect.forkChild(Effect.flip(source.discover))
      yield* Effect.yieldNow

      yield* TestClock.adjust("59 seconds")
      const early = running.pollUnsafe()
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(running)

      expect(early).toBeUndefined()
      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.isRetryable).toBe(true)
      expect(error.reason.message).toBe("The server did not answer within 60 seconds")
    })
  )

  it.effect("takes the timeout it is given, which a call of a tool counts in", () =>
    Effect.gen(function* () {
      const source = yield* Mcp.http({
        name: "wire",
        url: "http://localhost/mcp",
        client: neverCalls(),
        timeout: "5 seconds"
      })
      const listed = yield* source.discover
      const running = yield* Effect.forkChild(Effect.flip(source.call("slow", {})))
      yield* Effect.yieldNow

      yield* TestClock.adjust("5 seconds")
      const error = yield* Fiber.join(running)

      expect(listed.map((definition) => definition.name)).toEqual(["slow"])
      expect(error.reason.message).toBe("The server did not answer within 5 seconds")
    })
  )
})
