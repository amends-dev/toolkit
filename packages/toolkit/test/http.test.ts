import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Http from "../src/Http.ts"

interface Received {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
  readonly contentType: string | undefined
}

/** What the scripted API answers. */
interface Answer {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string
}

const json = { "content-type": "application/json" }

/** Answers what `answer` says to each request, and records what was asked. */
const scripted = (answer: (received: Received) => Answer = () => ({ headers: json, body: "{}" })) => {
  const received: Array<Received> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body = request.body as { readonly body?: Uint8Array; readonly contentType?: string }
      const sent: Received = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers },
        body: body.body === undefined ? undefined : new TextDecoder().decode(body.body),
        contentType: body.contentType
      }
      received.push(sent)
      const reply = answer(sent)
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body ?? "", {
          status: reply.status ?? 200,
          headers: reply.headers ?? {}
        })
      )
    })
  )
  return { client, received }
}

const operation = (name: string, request: Partial<Http.RequestTemplate> = {}): Http.Operation => ({
  definition: { name, inputSchema: { type: "object" }, annotations: {} },
  request: { method: "GET", path: "/", parameters: [], ...request }
})

const issue = operation("get_issue", {
  path: "/repos/{owner}/{repo}/issues/{number}",
  parameters: [
    { in: "path", name: "owner", property: "owner" },
    { in: "path", name: "repo", property: "repo" },
    { in: "path", name: "number", property: "number" }
  ]
})

const baseUrl = "https://api.example.com/v1/"

const connect = (client: HttpClient.HttpClient, operations: ReadonlyArray<Http.Operation>) =>
  Http.make({ name: "example", baseUrl, client, operations })

describe("Http.make", () => {
  it.effect("lists the definitions of its operations, without asking the API", () =>
    Effect.gen(function* () {
      const { client, received } = scripted()
      const source = yield* connect(client, [issue, operation("ping")])

      const definitions = yield* source.discover

      expect(definitions.map((definition) => definition.name)).toEqual(["get_issue", "ping"])
      expect(received).toEqual([])
    })
  )

  it.effect("has no two operations of one name", () =>
    Effect.gen(function* () {
      const { client } = scripted()

      const exit = yield* Effect.exit(connect(client, [operation("ping"), operation("ping")]))

      expect(exit._tag).toBe("Failure")
    })
  )

  it.effect("fails a call for an operation it does not have", () =>
    Effect.gen(function* () {
      const { client } = scripted()
      const source = yield* connect(client, [operation("ping")])

      const error = yield* Effect.flip(source.call("pong", {}))

      expect(error.reason._tag).toBe("NotFoundError")
    })
  )

  it.effect("has operations that a catalog can store, as JSON", () =>
    Effect.gen(function* () {
      const json = Schema.toCodecJson(Http.Operation)
      const withBody = operation("create", {
        method: "POST",
        path: "/things",
        parameters: [{ in: "header", name: "X-Request-Id", property: "request_id" }],
        body: "body"
      })

      const stored = JSON.stringify(yield* Schema.encodeEffect(json)(withBody))

      expect(yield* Schema.decodeUnknownEffect(json)(JSON.parse(stored))).toEqual(withBody)
    })
  )
})

describe("the request of a call", () => {
  const send = (operations: ReadonlyArray<Http.Operation>, tool: string, input: Schema.JsonObject) =>
    Effect.gen(function* () {
      const { client, received } = scripted()
      const source = yield* connect(client, operations)
      yield* source.call(tool, input)
      return received
    })

  it.effect("goes to the base URL and the path, with the values of the path encoded", () =>
    Effect.gen(function* () {
      const received = yield* send([issue], "get_issue", {
        owner: "my org",
        repo: "a/b?c#d",
        number: 7
      })

      expect(received[0]?.method).toBe("GET")
      expect(received[0]?.url).toBe("https://api.example.com/v1/repos/my%20org/a%2Fb%3Fc%23d/issues/7")
    })
  )

  it.effect("asks for JSON", () =>
    Effect.gen(function* () {
      const received = yield* send([operation("ping")], "ping", {})

      expect(received[0]?.headers["accept"]).toBe("application/json")
    })
  )

  it.effect("has the query, with a list as one parameter for each value, and nothing for a null", () =>
    Effect.gen(function* () {
      const search = operation("search", {
        path: "/search",
        parameters: [
          { in: "query", name: "q", property: "q" },
          { in: "query", name: "tag", property: "tags" },
          { in: "query", name: "page", property: "page" },
          { in: "query", name: "draft", property: "draft" },
          { in: "query", name: "since", property: "since" }
        ]
      })

      const received = yield* send([search], "search", {
        q: "a&b=c d",
        tags: ["x", "y z"],
        page: 2,
        draft: false,
        since: null
      })

      expect(received[0]?.url).toBe("https://api.example.com/v1/search?q=a%26b%3Dc+d&tag=x&tag=y+z&page=2&draft=false")
    })
  )

  it.effect("has the headers, with a list joined by commas", () =>
    Effect.gen(function* () {
      const tagged = operation("tagged", {
        parameters: [
          { in: "header", name: "X-Request-Id", property: "request_id" },
          { in: "header", name: "X-Labels", property: "labels" }
        ]
      })

      const received = yield* send([tagged], "tagged", {
        request_id: "r-1",
        labels: ["a", "b"]
      })

      expect(received[0]?.headers["x-request-id"]).toBe("r-1")
      expect(received[0]?.headers["x-labels"]).toBe("a,b")
    })
  )

  it.effect("has the body as JSON, and no body when the input has none", () =>
    Effect.gen(function* () {
      const create = operation("create", { method: "POST", path: "/things", body: "body" })

      const withBody = yield* send([create], "create", { body: { title: "Broken build", n: [1] } })
      const without = yield* send([create], "create", {})

      expect(withBody[0]?.method).toBe("POST")
      expect(withBody[0]?.contentType).toBe("application/json")
      expect(JSON.parse(withBody[0]?.body ?? "")).toEqual({ title: "Broken build", n: [1] })
      expect(without[0]?.body).toBeUndefined()
    })
  )

  it.effect("has only what the operation has places for", () =>
    Effect.gen(function* () {
      const received = yield* send([operation("ping")], "ping", {
        stray: "value",
        body: { not: "sent" }
      })

      expect(received[0]?.url).toBe("https://api.example.com/v1/")
      expect(received[0]?.body).toBeUndefined()
    })
  )

  it.effect("carries the credentials of the client, which come after what the source sets", () =>
    Effect.gen(function* () {
      const { client, received } = scripted()
      const source = yield* connect(
        HttpClient.mapRequest(client, HttpClientRequest.setHeader("authorization", "Bearer secret")),
        [operation("ping")]
      )

      yield* source.call("ping", {})

      expect(received[0]?.headers["authorization"]).toBe("Bearer secret")
    })
  )
})

describe("an input that does not fit the request", () => {
  const refuse = (operations: ReadonlyArray<Http.Operation>, tool: string, input: Schema.JsonObject) =>
    Effect.gen(function* () {
      const { client, received } = scripted()
      const source = yield* connect(client, operations)
      const error = yield* Effect.flip(source.call(tool, input))
      return { error, received }
    })

  it.effect("is refused before anything is sent, and says what to correct", () =>
    Effect.gen(function* () {
      const { error, received } = yield* refuse([issue], "get_issue", { owner: "a", repo: "b" })

      expect(error.reason._tag).toBe("InvalidInputError")
      expect(error.reason.modelMessage).toBe("`number` must be given")
      expect(received).toEqual([])
    })
  )

  it.effect("is refused when a value in the path is a part of the path, or is empty", () =>
    Effect.gen(function* () {
      for (const value of ["..", ".", ""]) {
        const { error, received } = yield* refuse([issue], "get_issue", {
          owner: value,
          repo: "b",
          number: 1
        })

        expect(error.reason._tag).toBe("InvalidInputError")
        expect(error.reason.modelMessage).toContain("`owner`")
        expect(received).toEqual([])
      }
    })
  )

  it.effect("is refused when a value is not a string, a number, or a boolean", () =>
    Effect.gen(function* () {
      const inPath = yield* refuse([issue], "get_issue", { owner: ["a"], repo: "b", number: 1 })
      const inPathObject = yield* refuse([issue], "get_issue", {
        owner: { a: 1 },
        repo: "b",
        number: 1
      })
      const search = operation("search", {
        parameters: [{ in: "query", name: "q", property: "q" }]
      })
      const inQuery = yield* refuse([search], "search", { q: { deep: "object" } })
      const inList = yield* refuse([search], "search", { q: ["a", ["b"]] })

      expect(inPath.error.reason.modelMessage).toBe("`owner` must be a string, a number, or a boolean")
      expect(inPathObject.error.reason._tag).toBe("InvalidInputError")
      expect(inQuery.error.reason.modelMessage).toBe("`q` must be a string, a number, or a boolean, or a list of them")
      expect(inList.error.reason._tag).toBe("InvalidInputError")
    })
  )

  it.effect("is refused when a header would hold a character that adds another header", () =>
    Effect.gen(function* () {
      const tagged = operation("tagged", {
        parameters: [{ in: "header", name: "X-Label", property: "label" }]
      })

      const newline = yield* refuse([tagged], "tagged", { label: "a\r\nX-Admin: 1" })
      const wide = yield* refuse([tagged], "tagged", { label: "café ☃" })

      expect(newline.error.reason._tag).toBe("InvalidInputError")
      expect(wide.error.reason._tag).toBe("InvalidInputError")
      expect(newline.received).toEqual([])
    })
  )
})

describe("the answer to a call", () => {
  const answerWith = (reply: Answer, method: Http.Method = "GET") =>
    Effect.gen(function* () {
      const { client } = scripted(() => reply)
      const source = yield* connect(client, [operation("ping", { method })])
      return yield* source.call("ping", {})
    })

  it.effect("is the JSON body, as JSON, or the text of a text body", () =>
    Effect.gen(function* () {
      const object = yield* answerWith({ headers: json, body: '{"id":7,"labels":["bug"]}' })
      const problem = yield* answerWith({
        headers: { "content-type": "application/problem+json; charset=utf-8" },
        body: '{"ok":true}'
      })
      const text = yield* answerWith({ headers: { "content-type": "text/plain" }, body: "pong" })
      const untyped = yield* answerWith({ body: "pong" })

      expect(object).toEqual({ id: 7, labels: ["bug"] })
      expect(problem).toEqual({ ok: true })
      expect(text).toBe("pong")
      expect(untyped).toBe("pong")
    })
  )

  it.effect("is null when there is no body", () =>
    Effect.gen(function* () {
      expect(yield* answerWith({ status: 204 })).toBeNull()
      expect(yield* answerWith({ headers: json, body: "" })).toBeNull()
      expect(yield* answerWith({ status: 200 }, "HEAD")).toBeNull()
    })
  )

  it.effect("is a failed call when it is a body the source cannot read", () =>
    Effect.gen(function* () {
      const image = yield* Effect.flip(answerWith({ headers: { "content-type": "image/png" }, body: "PNG" }))
      const broken = yield* Effect.flip(answerWith({ headers: json, body: "{not json" }))

      expect(image.reason._tag).toBe("UnsupportedError")
      expect(broken.reason._tag).toBe("InvalidResponseError")
    })
  )
})

describe("a call that fails", () => {
  const failWith = (
    reply: Answer,
    around: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client
  ) =>
    Effect.gen(function* () {
      const { client } = scripted(() => reply)
      const source = yield* connect(around(client), [operation("ping")])
      return yield* Effect.flip(source.call("ping", {}))
    })

  it.effect("is read by the status of the answer", () =>
    Effect.gen(function* () {
      const reasons = []
      for (const status of [301, 401, 403, 404, 408, 409, 422, 429, 500, 503]) {
        const error = yield* failWith({ status })
        reasons.push([status, error.reason._tag, error.isRetryable])
      }

      expect(reasons).toEqual([
        [301, "InvalidResponseError", false],
        [401, "AuthenticationError", false],
        [403, "AuthenticationError", false],
        [404, "CallFailedError", false],
        [408, "UnavailableError", true],
        [409, "CallFailedError", false],
        [422, "CallFailedError", false],
        [429, "UnavailableError", true],
        [500, "UnavailableError", true],
        [503, "UnavailableError", true]
      ])
    })
  )

  it.effect("tells the model what the API said of a request it refuses, in a few words", () =>
    Effect.gen(function* () {
      const said = yield* failWith({
        status: 422,
        headers: json,
        body: '{"message":"title is required"}\n'
      })
      const silent = yield* failWith({ status: 404 })
      const long = yield* failWith({ status: 400, body: "x".repeat(2000) })

      expect(said.reason.modelMessage).toBe('422: {"message":"title is required"}')
      expect(silent.reason.modelMessage).toBe("The API answered 404")
      expect(long.reason.modelMessage).toBe(`400: ${"x".repeat(500)}...`)
    })
  )

  it.effect("tells the model nothing of what the API said when the API itself is at fault", () =>
    Effect.gen(function* () {
      const error = yield* failWith({
        status: 500,
        body: "Traceback: connect ECONNREFUSED 10.0.3.7:5432"
      })

      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.reason.modelMessage).toBe("The source is temporarily unavailable")
      expect(error.reason.message).not.toContain("10.0.3.7")
    })
  )

  it.effect("is read the same when the client rejects the statuses it does not accept", () =>
    Effect.gen(function* () {
      const refused = yield* failWith({ status: 401 }, HttpClient.filterStatusOk)
      const said = yield* failWith({ status: 422, body: "No" }, HttpClient.filterStatusOk)

      expect(refused.reason._tag).toBe("AuthenticationError")
      expect(said.reason.modelMessage).toBe("422: No")
    })
  )

  it.effect("is one that cannot be reached, which may be tried again", () =>
    Effect.gen(function* () {
      const unreachable = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "Refused" })
          })
        )
      )
      const source = yield* connect(unreachable, [operation("ping")])

      const error = yield* Effect.flip(source.call("ping", {}))

      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.isRetryable).toBe(true)
    })
  )
})

/** A server in this process, which the real client reaches over the wire. */
const serve = (handle: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch: handle })),
    (server) => Effect.promise(() => server.stop(true))
  )

describe("an API reached over the wire", () => {
  it.effect("is sent what the operation says, as the API receives it", () =>
    Effect.gen(function* () {
      const seen: Array<{
        readonly method: string
        readonly url: string
        readonly auth: string | null
        readonly type: string | null
        readonly body: string
      }> = []
      const server = yield* serve(async (request) => {
        seen.push({
          method: request.method,
          url: new URL(request.url).pathname + new URL(request.url).search,
          auth: request.headers.get("authorization"),
          type: request.headers.get("content-type"),
          body: await request.text()
        })
        return Response.json({ id: 7 }, { status: 201 })
      })
      const client = HttpClient.mapRequest(
        yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
        HttpClientRequest.setHeader("authorization", "Bearer secret")
      )
      const create = operation("create_comment", {
        method: "POST",
        path: "/issues/{id}/comments",
        parameters: [
          { in: "path", name: "id", property: "id" },
          { in: "query", name: "tag", property: "tags" }
        ],
        body: "body"
      })
      const source = yield* Http.make({
        name: "wire",
        baseUrl: `http://localhost:${server.port}/api`,
        client,
        operations: [create]
      })

      const answer = yield* source.call("create_comment", {
        id: "a/b",
        tags: ["x", "y"],
        body: { text: "Fixed in 4f2a" }
      })

      expect(answer).toEqual({ id: 7 })
      expect(seen).toEqual([
        {
          method: "POST",
          url: "/api/issues/a%2Fb/comments?tag=x&tag=y",
          auth: "Bearer secret",
          type: "application/json",
          body: '{"text":"Fixed in 4f2a"}'
        }
      ])
    })
  )

  it.effect("tells a failure of the request by what the API says", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => Response.json({ error: "No such issue" }, { status: 404 }))
      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
      const source = yield* Http.make({
        name: "wire",
        baseUrl: `http://localhost:${server.port}`,
        client,
        operations: [operation("get", { path: "/issues/1" })]
      })

      const error = yield* Effect.flip(source.call("get", {}))

      expect(error.reason._tag).toBe("CallFailedError")
      expect(error.reason.modelMessage).toBe('404: {"error":"No such issue"}')
    })
  )

  it.effect("is not reached by an address that goes nowhere, which may be tried again", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response("never"))
      const port = server.port
      yield* Effect.promise(() => server.stop(true))
      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
      const source = yield* Http.make({
        name: "wire",
        baseUrl: `http://localhost:${port}`,
        client,
        operations: [operation("get", { path: "/" })]
      })

      const error = yield* Effect.flip(source.call("get", {}))

      expect(error.reason._tag).toBe("UnavailableError")
    })
  )
})

describe("limits", () => {
  const never = HttpClient.make(() => Effect.never)

  it.effect("fails a call the API does not answer within the timeout, 30 seconds by default, as unavailable", () =>
    Effect.gen(function* () {
      const source = yield* connect(never, [operation("ping")])
      const running = yield* Effect.forkChild(Effect.flip(source.call("ping", {})))
      yield* Effect.yieldNow

      yield* TestClock.adjust("29 seconds")
      const early = running.pollUnsafe()
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(running)

      expect(early).toBeUndefined()
      expect(error.reason._tag).toBe("UnavailableError")
      expect(error.isRetryable).toBe(true)
      expect(error.reason.message).toBe("The API did not answer within 30 seconds")
    })
  )

  it.effect("takes the timeout it is given", () =>
    Effect.gen(function* () {
      const source = yield* Http.make({
        name: "example",
        baseUrl,
        client: never,
        operations: [operation("ping")],
        timeout: "2 seconds"
      })
      const running = yield* Effect.forkChild(Effect.flip(source.call("ping", {})))
      yield* Effect.yieldNow

      yield* TestClock.adjust("2 seconds")
      const error = yield* Fiber.join(running)

      expect(error.reason.message).toBe("The API did not answer within 2 seconds")
    })
  )

  it.effect("refuses an answer longer than 200,000 characters by default, telling the model to ask for less", () =>
    Effect.gen(function* () {
      const { client } = scripted(() => ({ headers: json, body: JSON.stringify({ items: "x".repeat(200_000) }) }))
      const source = yield* connect(client, [operation("ping")])

      const error = yield* Effect.flip(source.call("ping", {}))

      expect(error.reason._tag).toBe("CallFailedError")
      expect(error.isRetryable).toBe(false)
      expect(error.reason.modelMessage).toBe(
        "The answer is longer than 200000 characters, which a tool cannot return; ask for less"
      )
    })
  )

  it.effect("takes the answer length it is given, and returns an answer within it", () =>
    Effect.gen(function* () {
      const { client } = scripted(() => ({ headers: json, body: JSON.stringify({ items: "x".repeat(90) }) }))
      const make = (maxAnswerLength: number) =>
        Http.make({ name: "example", baseUrl, client, operations: [operation("ping")], maxAnswerLength })

      const fits = yield* (yield* make(200)).call("ping", {})
      const error = yield* Effect.flip((yield* make(100)).call("ping", {}))

      expect(fits).toEqual({ items: "x".repeat(90) })
      expect(error.reason._tag).toBe("CallFailedError")
    })
  )
})
