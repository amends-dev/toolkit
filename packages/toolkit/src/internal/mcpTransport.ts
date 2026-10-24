/**
 * How a source speaks to an MCP server: JSON-RPC over Streamable HTTP, with an HTTP client the
 * caller has already given the credentials the server asks for, so no credential enters this
 * package. The transport knows nothing of tools: it sends a request and decodes the result.
 *
 * It speaks the stateless protocol of 2026-07-28 to a server that does, and otherwise the protocol
 * with sessions that older servers speak, which starts with `initialize`. It finds out which when it
 * first needs the server, and again when the server ends a session.
 */

import * as McpSchema from "effect/ai/McpSchema"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as ToolSourceError from "../ToolSourceError.ts"
import { encodeHeaderValue } from "./mcpHeaders.ts"

/**
 * What `streamableHttp` and `Mcp.http` take: the source's name, the server's address, the client
 * that sends requests with the server's credentials, and who the client says it is.
 */
export interface Options {
  /** Names the source, as `ToolSource.name` says. */
  readonly name: string

  /** The address of the server's MCP endpoint, which every request is posted to. */
  readonly url: string

  /** Sends the requests, with the credentials the server asks for set on every one of them. */
  readonly client: HttpClient.HttpClient

  /** Tells the server who is asking. */
  readonly clientInfo?: { readonly name: string; readonly version: string }

  /**
   * How long a request may take, from sending it to reading the server's reply, which a call of a
   * tool counts in. A request that takes longer fails as `UnavailableError`. A minute by default.
   */
  readonly timeout?: Duration.Input
}

/**
 * The connection to one MCP server that `streamableHttp` makes, through which the source of
 * `Mcp.http` sends its requests. The first request settles how the server is spoken to.
 */
export interface Transport {
  /**
   * Sends a request over the connection, which it settles first, and starts another if the server
   * ended the one it had. It decodes the result with `schema`. A `toolName` is the name of the tool
   * a `tools/call` runs, and `headers` mirror its parameters, which only the stateless protocol has.
   */
  readonly request: <A, I>(
    schema: Schema.Codec<A, I>,
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
    options?: {
      readonly toolName?: string
      readonly headers?: Readonly<Record<string, string>>
    }
  ) => Effect.Effect<A, ToolSourceError.ToolSourceError>

  /** Whether the server is spoken to statelessly, as the protocols with headers that mirror parameters are. */
  readonly mirrorsParameters: Effect.Effect<boolean, ToolSourceError.ToolSourceError>
}

const statelessVersion = "2026-07-28"

/** The protocols with sessions this source speaks, newest first. */
const newestSessionVersion = "2025-11-25"
const sessionVersions = [newestSessionVersion, "2025-06-18", "2025-03-26", "2024-11-05"]

/** How the server is spoken to, which the first request settles. */
type Connection = Data.TaggedEnum<{
  Stateless: {}
  Session: {
    readonly protocolVersion: string

    /** A server may not give one. */
    readonly sessionId: string | undefined
  }
}>

const Connection = Data.taggedEnum<Connection>()

/** The server has ended the session a request belonged to, so the next request starts another. */
class SessionEnded extends Data.TaggedError("SessionEnded")<{
  readonly connection: Connection
}> {}

/**
 * The cause of the failure of a request that the server refused because its headers do not match its
 * body, which a call of a tool is answered with when it lacks the headers the server's tool marks.
 */
class HeaderMismatch extends Data.TaggedError("HeaderMismatch") {}

/**
 * Whether a request failed because the server found its headers did not match its body, which
 * `Mcp.http` answers by listing the tools again.
 */
export const isHeaderMismatch = (error: ToolSourceError.ToolSourceError) => error.cause instanceof HeaderMismatch

const isToolSourceError = Schema.is(ToolSourceError.ToolSourceError)

/** What a server answers a request with, as JSON-RPC defines it. */
const Reply = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Finite, Schema.Null]),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Finite, message: Schema.String }))
})

const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))

const Discovered = Schema.Struct({ supportedVersions: Schema.Array(Schema.String) })

const Initialized = Schema.Struct({ protocolVersion: Schema.String })

/**
 * Makes the transport to the MCP server at `options.url`. Making it contacts nothing: the server
 * is first reached by the first request.
 */
export const streamableHttp = Effect.fn("Mcp.Transport.streamableHttp")(function* (options: Options) {
  const { name, url, client } = options
  const clientInfo = options.clientInfo ?? { name: "amends", version: "0.0.0" }
  const timeout = Duration.fromInputUnsafe(options.timeout ?? "1 minute")
  const requestCount = yield* Ref.make(0)
  const settledConnection = yield* Ref.make(Option.none<Connection>())
  const settling = yield* Semaphore.make(1)

  const fail = (reason: ToolSourceError.ToolSourceErrorReason, cause?: unknown) =>
    new ToolSourceError.ToolSourceError({ source: name, reason, cause })

  const failToReach = (error: HttpClientError.HttpClientError) =>
    fail(ToolSourceError.reasonFromHttpClientError(error), error)

  const failWithStatus = (status: number) => {
    const description = `The server answered ${status}`
    if (status === 401 || status === 403) return fail(new ToolSourceError.AuthenticationError({ description }))
    if (status === 408 || status === 429 || status >= 500) {
      return fail(new ToolSourceError.UnavailableError({ description }))
    }
    return fail(new ToolSourceError.UnsupportedError({ description }))
  }

  const failWithReply = (error: { readonly code: number; readonly message: string }) => {
    const description = error.message
    switch (error.code) {
      case McpSchema.INVALID_PARAMS_ERROR_CODE:
        return fail(new ToolSourceError.InvalidInputError({ description }))
      case McpSchema.HEADER_MISMATCH_ERROR_CODE:
        return fail(new ToolSourceError.UnsupportedError({ description }), new HeaderMismatch())
      case McpSchema.METHOD_NOT_FOUND_ERROR_CODE:
      case McpSchema.INVALID_REQUEST_ERROR_CODE:
      case McpSchema.PARSE_ERROR_CODE:
        return fail(new ToolSourceError.UnsupportedError({ description }))
      default:
        return fail(new ToolSourceError.UnknownError({ description }))
    }
  }

  /**
   * Sends a JSON-RPC request, or a notification, and returns the response whatever its status,
   * which a client that rejects statuses reports as a failure.
   */
  const post = Effect.fnUntraced(function* (
    connection: Connection,
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
    options?: {
      readonly id?: number
      readonly toolName?: string
      readonly headers?: Readonly<Record<string, string>>
    }
  ) {
    // A stateless request says what it is in its headers and carries its protocol in its params; a
    // request in a session names the session.
    const spoken = Connection.$match(connection, {
      Stateless: () => ({
        version: statelessVersion,
        headers: {
          "mcp-method": method,
          ...(options?.toolName === undefined ? {} : { "mcp-name": encodeHeaderValue(options.toolName) }),
          ...options?.headers
        },
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": statelessVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": clientInfo
          }
        }
      }),
      Session: ({ protocolVersion, sessionId }) => ({
        version: protocolVersion,
        headers: sessionId === undefined ? {} : { "mcp-session-id": sessionId },
        params
      })
    })
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": spoken.version,
        ...spoken.headers
      }),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        ...(options?.id === undefined ? {} : { id: options.id }),
        method,
        params: spoken.params
      })
    )
    return yield* client.execute(request).pipe(
      Effect.catchReason("HttpClientError", "StatusCodeError", (reason) => Effect.succeed(reason.response)),
      Effect.mapError(failToReach)
    )
  })

  /** Reads the reply to request `id` from a response, which is JSON or a stream of events. */
  const readReply = (response: HttpClientResponse.HttpClientResponse, id: number) => {
    const isStream = (response.headers["content-type"] ?? "").includes("text/event-stream")
    // Whatever fails to be read is reported as one failure, so the errors are not told apart.
    const replies: Stream.Stream<typeof Reply.Type, unknown> = isStream
      ? response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((event) => event.data),
          Stream.filter((data) => data.length > 0),
          Stream.mapEffect((data) => Effect.option(decodeReply(data))),
          Stream.filter(Option.isSome),
          Stream.map((reply) => reply.value)
        )
      : Stream.fromEffect(Effect.flatMap(response.text, decodeReply))
    return replies.pipe(
      // A message that is no reply to this request, such as a notification, is not for the source.
      // A server that cannot tell which request failed gives the failure no id, as JSON-RPC says.
      Stream.filter(
        (reply) =>
          (reply.id === id && (reply.result !== undefined || reply.error !== undefined)) ||
          (reply.id === null && reply.error !== undefined)
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(new ToolSourceError.InvalidResponseError({ description: "No reply" }))),
          onSome: Effect.succeed
        })
      ),
      Effect.mapError((error) =>
        isToolSourceError(error)
          ? error
          : fail(
              new ToolSourceError.InvalidResponseError({
                description: "The reply is not JSON-RPC"
              }),
              error
            )
      )
    )
  }

  /** Reads what the response to request `id` says: its result, or the failure it reports. */
  const readResult = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, id: number) {
    if (response.status === 401 || response.status === 403) {
      return yield* failWithStatus(response.status)
    }
    const reply = yield* readReply(response, id).pipe(
      // A server that fails a request without a reply, or an HTTP error, is read by its status.
      Effect.catchIf(
        () => response.status >= 400,
        () => Effect.fail(failWithStatus(response.status))
      )
    )
    if (reply.error !== undefined) return yield* failWithReply(reply.error)
    return reply.result ?? null
  })

  /** Sends a request and decodes its result, as the server's reply to it has it. */
  const exchange = Effect.fnUntraced(function* <A, I>(
    schema: Schema.Codec<A, I>,
    connection: Connection,
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
    options?: {
      readonly toolName?: string
      readonly headers?: Readonly<Record<string, string>>
    }
  ) {
    const id = yield* Ref.updateAndGet(requestCount, (count) => count + 1)
    const response = yield* post(connection, method, params, { ...options, id })
    if (response.status === 404 && Connection.$is("Session")(connection) && connection.sessionId) {
      return yield* new SessionEnded({ connection })
    }
    const result = yield* readResult(response, id)
    return yield* Schema.decodeUnknownEffect(schema)(result).pipe(
      Effect.mapError((error) =>
        fail(
          new ToolSourceError.InvalidResponseError({
            description: `The result of ${method} is not as expected`
          }),
          error
        )
      )
    )
  })

  /** Starts a session with a server that has them. */
  const initialize = Effect.gen(function* () {
    const unstarted = Connection.Session({ protocolVersion: newestSessionVersion, sessionId: undefined })
    const params = { protocolVersion: newestSessionVersion, capabilities: {}, clientInfo }
    const id = yield* Ref.updateAndGet(requestCount, (count) => count + 1)
    const response = yield* post(unstarted, "initialize", params, { id })
    const answer = yield* readResult(response, id).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Initialized)),
      Effect.mapError((error) =>
        isToolSourceError(error)
          ? error
          : fail(
              new ToolSourceError.InvalidResponseError({
                description: "The result of initialize is not as expected"
              }),
              error
            )
      )
    )
    if (!sessionVersions.includes(answer.protocolVersion)) {
      return yield* fail(
        new ToolSourceError.UnsupportedError({
          description: `The server speaks ${answer.protocolVersion}, which is not supported`
        })
      )
    }
    const connection = Connection.Session({
      protocolVersion: answer.protocolVersion,
      sessionId: response.headers["mcp-session-id"]
    })
    const acknowledged = yield* post(connection, "notifications/initialized", {})
    if (acknowledged.status >= 400) return yield* failWithStatus(acknowledged.status)
    return connection
  })

  /** Finds out how the server is spoken to: statelessly if it says it can be, or else with sessions. */
  const settleConnection = Effect.gen(function* () {
    const stateless = Connection.Stateless()
    const isStateless = yield* exchange(Discovered, stateless, "server/discover", {}).pipe(
      Effect.map((discovered) => discovered.supportedVersions.includes(statelessVersion)),
      // A stateless request carries no session, so none can have ended.
      Effect.catchTag("SessionEnded", () => Effect.succeed(false)),
      // A server that is not reached, or does not let the source in, would not answer `initialize`
      // either. Any other failure is one an older server gives to a method it does not know.
      Effect.catchIf(
        (error) =>
          !ToolSourceError.ToolSourceErrorReason.isAnyOf(["AuthenticationError", "UnavailableError"])(error.reason),
        () => Effect.succeed(false)
      )
    )
    return isStateless ? stateless : yield* initialize
  })

  const connection = settling.withPermit(
    Ref.get(settledConnection).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => settleConnection.pipe(Effect.tap((settled) => Ref.set(settledConnection, Option.some(settled))))
        })
      )
    )
  )

  /** Forgets `ended`, unless another request has already settled a new connection. */
  const forgetConnection = (ended: Connection) =>
    Ref.update(
      settledConnection,
      Option.filter((current) => current !== ended)
    )

  const timedOut = Effect.fail(
    fail(
      new ToolSourceError.UnavailableError({
        description: `The server did not answer within ${Duration.toMillis(timeout) / 1000} seconds`
      })
    )
  )

  const request: Transport["request"] = (schema, method, params, options) => {
    const attempt = connection.pipe(Effect.flatMap((settled) => exchange(schema, settled, method, params, options)))
    return attempt.pipe(
      Effect.catchTag("SessionEnded", (ended) =>
        forgetConnection(ended.connection).pipe(
          Effect.andThen(attempt),
          Effect.catchTag("SessionEnded", () =>
            Effect.fail(
              fail(
                new ToolSourceError.UnavailableError({
                  description: "The server keeps ending the session"
                })
              )
            )
          )
        )
      ),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut })
    )
  }

  const transport: Transport = {
    request,
    mirrorsParameters: Effect.map(connection, Connection.$is("Stateless"))
  }
  return transport
})
