/**
 * An MCP server as a tool source, reached over Streamable HTTP with an HTTP client the caller has
 * already given the credentials the server asks for, so no credential enters this package. The
 * source asks the server for its tools and runs them, and nothing else of MCP: resources, prompts,
 * and the requests a server makes of its client are left out.
 *
 * How the server is spoken to, statelessly or with a session, is the transport's to settle. The
 * source adds what only tools have: the headers that mirror the parameters a tool marks.
 *
 * @since 0.1.0
 */

import * as McpSchema from "effect/ai/McpSchema"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { findBindings, headersOf, type Binding } from "./internal/mcpHeaders.ts"
import * as Transport from "./internal/mcpTransport.ts"
import type { Options } from "./internal/mcpTransport.ts"
import type * as ToolDefinition from "./ToolDefinition.ts"
import type * as ToolSource from "./ToolSource.ts"
import * as ToolSourceError from "./ToolSourceError.ts"

export type {
  /**
   * What `http` takes: the source's name, the server's address, the client that sends its
   * requests with the server's credentials, and how long a request may take.
   *
   * @category options
   * @since 0.1.0
   */
  Options
}

const Tool = Schema.Struct({
  name: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: McpSchema.ToolJson,
  annotations: Schema.optionalKey(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      readOnlyHint: Schema.optionalKey(Schema.Boolean),
      destructiveHint: Schema.optionalKey(Schema.Boolean),
      idempotentHint: Schema.optionalKey(Schema.Boolean),
      openWorldHint: Schema.optionalKey(Schema.Boolean)
    })
  )
})

const ToolList = Schema.Struct({
  tools: Schema.Array(Tool),
  nextCursor: Schema.optionalKey(Schema.String)
})

const ToolResult = Schema.Struct({
  /** `complete`, or `input_required` when the tool asks the caller for something first. */
  resultType: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Json)),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean)
})

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

/** The most pages of tools a server may list before the source takes its cursors for a loop. */
const maxToolPages = 100

/**
 * Makes a source of the tools of the MCP server at `options.url`. Making it contacts nothing: the
 * server is first reached when the source lists or runs its tools. A tool that reports `isError`
 * fails as `CallFailedError`, with what it said, and one that asks for input first as
 * `UnsupportedError`.
 *
 * **Example** (A source of an MCP server, with the server's credentials on the client)
 *
 * ```ts
 * import { Mcp } from "@amends-dev/toolkit"
 * import { Config, Effect, Redacted } from "effect"
 * import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
 *
 * const program = Effect.gen(function* () {
 *   const token = yield* Config.Redacted("MCP_TOKEN")
 *   // The client carries the credentials, so the source never sees them.
 *   const client = (yield* HttpClient.HttpClient).pipe(
 *     HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(token)))
 *   )
 *   const tasks = yield* Mcp.http({ name: "tasks", url: "https://mcp.example.com/mcp", client })
 *   // The server is first reached here: the catalog stores what it lists.
 *   const definitions = yield* tasks.discover
 *   const result = yield* tasks.call("list_tasks", { status: "open" })
 *   return { definitions, result }
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const http = Effect.fn("Mcp.http")(function* (options: Options) {
  const { name } = options
  const transport = yield* Transport.streamableHttp(options)

  const fail = (reason: ToolSourceError.ToolSourceErrorReason, cause?: unknown) =>
    new ToolSourceError.ToolSourceError({ source: name, reason, cause })

  const listPages = (
    cursor: string | undefined,
    listed: ReadonlyArray<typeof Tool.Type>,
    pagesLeft: number
  ): Effect.Effect<ReadonlyArray<typeof Tool.Type>, ToolSourceError.ToolSourceError> =>
    transport.request(ToolList, "tools/list", cursor === undefined ? {} : { cursor }).pipe(
      Effect.flatMap((page) => {
        const tools = [...listed, ...page.tools]
        if (page.nextCursor === undefined) return Effect.succeed(tools)
        return pagesLeft > 1
          ? listPages(page.nextCursor, tools, pagesLeft - 1)
          : Effect.fail(
              fail(
                new ToolSourceError.InvalidResponseError({
                  description: "The tool list does not end"
                })
              )
            )
      })
    )

  /** The parameters of each tool that is sent as a header too, as of the last time they were listed. */
  const listedBindings = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Binding>>>(new Map())

  /**
   * Asks the server for its tools, and remembers which of their parameters are sent as headers, so
   * that a call can send them. A tool that a client may not use, because of what it marks, is left
   * out and logged.
   */
  const listTools = Effect.gen(function* () {
    const tools = yield* listPages(undefined, [], maxToolPages)
    const { usable, refused } = sortTools(tools, yield* transport.mirrorsParameters)
    for (const { tool, reason } of refused) {
      yield* Effect.logWarning(`Leaving out the tool ${tool.name} of ${name}: ${reason}`)
    }
    yield* Ref.set(listedBindings, new Map(usable.map(({ tool, bindings }) => [tool.name, bindings])))
    return usable.map(({ tool }) => definitionOf(tool))
  })

  const headersOfCall = (
    bindings: ReadonlyMap<string, ReadonlyArray<Binding>>,
    tool: string,
    input: Schema.JsonObject
  ) => headersOf(bindings.get(tool) ?? [], input)

  /**
   * Runs a tool. A server may refuse a call that does not send the parameters its tool marks as
   * headers, so the call sends what the last listing says, and a source that has not listed the
   * tools, or a server whose tools have changed, is told so by the server: it lists the tools again,
   * and sends the call once more with the headers they ask for, if those are other headers.
   */
  const callTool = Effect.fnUntraced(function* (tool: string, input: Schema.JsonObject) {
    const send = (headers: Readonly<Record<string, string>>) =>
      transport.request(ToolResult, "tools/call", { name: tool, arguments: input }, { toolName: tool, headers })
    const mirrorsParameters = yield* transport.mirrorsParameters
    const sent = mirrorsParameters ? headersOfCall(yield* Ref.get(listedBindings), tool, input) : {}
    return yield* send(sent).pipe(
      Effect.catchIf(Transport.isHeaderMismatch, (mismatch) =>
        Effect.gen(function* () {
          // Only the stateless protocol has headers to send.
          if (!mirrorsParameters) return yield* mismatch
          yield* listTools
          const listed = headersOfCall(yield* Ref.get(listedBindings), tool, input)
          // The headers that the listing does not change are the ones the server has refused.
          return sameHeaders(sent, listed) ? yield* mismatch : yield* send(listed)
        })
      )
    )
  })

  const source: ToolSource.ToolSource = {
    name,
    discover: listTools,
    call: (tool, input) => callTool(tool, input).pipe(Effect.flatMap((result) => resultOf(result, fail)))
  }
  return source
})

/** The definition of a tool as an MCP server lists it. */
const definitionOf = (tool: typeof Tool.Type): ToolDefinition.ToolDefinition => {
  const hints = tool.annotations
  const title = hints?.title ?? tool.title
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    annotations: {
      ...(title === undefined ? {} : { title }),
      ...(hints?.readOnlyHint === undefined ? {} : { readOnly: hints.readOnlyHint }),
      ...(hints?.destructiveHint === undefined ? {} : { destructive: hints.destructiveHint }),
      ...(hints?.idempotentHint === undefined ? {} : { idempotent: hints.idempotentHint }),
      ...(hints?.openWorldHint === undefined ? {} : { openWorld: hints.openWorldHint })
    }
  }
}

/**
 * The tools of a listing that a source may offer, each with the parameters it sends as headers. A
 * client of the stateless protocol may not use a tool that marks its parameters in a way the
 * protocol does not allow, since a server would refuse its calls, and any other protocol has no use
 * for the marks.
 */
const sortTools = (tools: ReadonlyArray<typeof Tool.Type>, sendsParametersAsHeaders: boolean) => {
  const usable: Array<{ tool: typeof Tool.Type; bindings: ReadonlyArray<Binding> }> = []
  const refused: Array<{ tool: typeof Tool.Type; reason: string }> = []
  for (const tool of tools) {
    if (!sendsParametersAsHeaders) {
      usable.push({ tool, bindings: [] })
      continue
    }
    const found = findBindings(tool.inputSchema)
    if (Result.isSuccess(found)) usable.push({ tool, bindings: found.success })
    else refused.push({ tool, reason: found.failure })
  }
  return { usable, refused }
}

const sameHeaders = (first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>) => {
  const names = Object.keys(first)
  return names.length === Object.keys(second).length && names.every((n) => first[n] === second[n])
}

/**
 * What a tool answers with: the structured content when it has some, or else the content blocks,
 * which MCP leaves as the tool wrote them. A tool that reports a failure is a failed call, with what
 * it said as text.
 */
const resultOf = (
  result: typeof ToolResult.Type,
  fail: (reason: ToolSourceError.ToolSourceErrorReason) => ToolSourceError.ToolSourceError
) => {
  if (result.resultType === "input_required") {
    return Effect.fail(
      fail(
        new ToolSourceError.UnsupportedError({
          description: "The tool asks for input, which is not supported"
        })
      )
    )
  }
  if (result.isError === true) {
    const said = (result.content ?? []).filter(Schema.is(TextBlock)).map((block) => block.text)
    return Effect.fail(
      fail(new ToolSourceError.CallFailedError(said.length === 0 ? {} : { description: said.join("\n") }))
    )
  }
  return Effect.succeed(result.structuredContent ?? result.content ?? [])
}
