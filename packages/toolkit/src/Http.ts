/**
 * An HTTP API as a tool source. Each tool is one operation: a request with places in it for what the
 * model gives, which the definition of the tool describes. An operation is data, so a catalog can
 * store it, and `OpenApi` makes the operations of an API from its specification.
 *
 * The source sends requests to one base URL, over an HTTP client the caller has already given the
 * credentials the API asks for, so no credential enters this package. What the model gives never
 * decides where a request goes: it fills the places the operation has for it, as the segments of the
 * path, the parameters of the query, the headers, and the body, which is JSON.
 *
 * @since 0.1.0
 */

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ToolDefinition from "./ToolDefinition.ts"
import type * as ToolSource from "./ToolSource.ts"
import * as ToolSourceError from "./ToolSourceError.ts"

/**
 * The HTTP methods an operation's request may use.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Method = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type Method = typeof Method.Type

/**
 * A place in a request for a property of the tool's input.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Parameter = Schema.Struct({
  /** Where the value goes: a segment of the path, a parameter of the query, or a header. */
  in: Schema.Literals(["path", "query", "header"]),

  /** What the request calls it: the name between braces in the path, or of the query or the header. */
  name: Schema.NonEmptyString,

  /** The property of the input that holds the value, which the definition's parameters name. */
  property: Schema.NonEmptyString
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Parameter extends Schema.Schema.Type<typeof Parameter> {}

/**
 * The request an operation sends, with places in it for what the model gives: its method, its
 * path, where each property of the input goes, and the property that holds the JSON body.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RequestTemplate = Schema.Struct({
  method: Method,

  /** The path after the base URL, with a parameter's name between braces where its value goes. */
  path: Schema.String,

  /** Where each property of the input goes, besides the body. */
  parameters: Schema.Array(Parameter),

  /** The property of the input that holds the body, which is sent as JSON, if the request has one. */
  body: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface RequestTemplate extends Schema.Schema.Type<typeof RequestTemplate> {}

/**
 * A tool that is one HTTP request: the definition the model is shown, and the request a call fills
 * in and sends. It is data, so a catalog can store it, and `OpenApi.readOperations` reads the
 * operations of an API from its document.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Operation = Schema.Struct({
  /** The tool as the model is shown it, whose name the source runs it by. */
  definition: ToolDefinition.ToolDefinition,

  /** The request a call fills in with its input and sends. */
  request: RequestTemplate
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Operation extends Schema.Schema.Type<typeof Operation> {}

/**
 * What `make` takes: the source's name, where its requests go, the client that sends them with the
 * API's credentials, and its operations.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** Names the source, as `ToolSource.name` says. */
  readonly name: string

  /** Where the requests go, which the operations' paths follow. */
  readonly baseUrl: string

  /** Sends the requests, with the credentials the API asks for set on every one of them. */
  readonly client: HttpClient.HttpClient

  /** The tools of the source, which must have distinct names. */
  readonly operations: ReadonlyArray<Operation>

  /**
   * How long a call may take, from sending its request to reading the answer. A call that takes
   * longer fails as `UnavailableError`. 30 seconds by default.
   */
  readonly timeout?: Duration.Input

  /**
   * The most characters an answer may have, which is what the model reads. A longer answer fails
   * the call as `CallFailedError`, telling the model to ask for less. 200,000 by default.
   */
  readonly maxAnswerLength?: number
}

/** The most of an answer that a failed call tells the model, which is all it needs to correct. */
const maxFailureLength = 500

const defaultMaxAnswerLength = 200_000

/**
 * Makes a source of the operations of an HTTP API. A call answered 401 or 403 fails with
 * `AuthenticationError`, 408, 429, or 5xx with `UnavailableError`, and any other 4xx with
 * `CallFailedError`, holding the API's own words cut to 500 characters. A success is the body as
 * JSON, as text, or `null` without one. A call that takes longer than `timeout` fails as
 * `UnavailableError`, and an answer longer than `maxAnswerLength` as `CallFailedError`.
 *
 * **Example** (A source of an API, from an operation written by hand)
 *
 * ```ts
 * import { Http } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 * import { FetchHttpClient, HttpClient } from "effect/http"
 *
 * const listIssues: Http.Operation = {
 *   definition: {
 *     name: "list_issues",
 *     description: "Lists the open issues of a repository",
 *     inputSchema: {
 *       type: "object",
 *       properties: {
 *         owner: { type: "string" },
 *         repo: { type: "string" },
 *         labels: { type: "string", description: "Labels the issues must have, separated by commas" }
 *       },
 *       required: ["owner", "repo"]
 *     },
 *     annotations: { readOnly: true }
 *   },
 *   request: {
 *     method: "GET",
 *     path: "/repos/{owner}/{repo}/issues",
 *     parameters: [
 *       { in: "path", name: "owner", property: "owner" },
 *       { in: "path", name: "repo", property: "repo" },
 *       { in: "query", name: "labels", property: "labels" }
 *     ]
 *   }
 * }
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* HttpClient.HttpClient
 *   const github = yield* Http.make({
 *     name: "github",
 *     baseUrl: "https://api.github.com",
 *     client,
 *     operations: [listIssues]
 *   })
 *   // Sends GET /repos/amends-dev/amends/issues?labels=bug, and answers with the body as JSON.
 *   return yield* github.call("list_issues", { owner: "amends-dev", repo: "amends", labels: "bug" })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const { name, client } = options
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const timeout = Duration.fromInputUnsafe(options.timeout ?? "30 seconds")
  const maxAnswerLength = options.maxAnswerLength ?? defaultMaxAnswerLength
  const operations = new Map(options.operations.map((operation) => [operation.definition.name, operation]))
  if (operations.size !== options.operations.length) {
    return yield* Effect.die(new Error(`${name} has more than one operation of the same name`))
  }

  const fail = (reason: ToolSourceError.ToolSourceErrorReason, cause?: unknown) =>
    new ToolSourceError.ToolSourceError({ source: name, reason, cause })

  const failToReach = (error: HttpClientError.HttpClientError) =>
    fail(ToolSourceError.reasonFromHttpClientError(error), error)

  /** Sends the request, and returns the response whatever its status. */
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.catchReason("HttpClientError", "StatusCodeError", (reason) => Effect.succeed(reason.response)),
      Effect.mapError(failToReach)
    )

  const readText = (response: HttpClientResponse.HttpClientResponse) => response.text.pipe(Effect.mapError(failToReach))

  /** What a response with a status that is not a success says, as a failure of the call. */
  const failWithStatus = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    const { status } = response
    const description = `The API answered ${status}`
    if (status === 401 || status === 403) return yield* fail(new ToolSourceError.AuthenticationError({ description }))
    if (status === 408 || status === 429 || status >= 500) {
      return yield* fail(new ToolSourceError.UnavailableError({ description }))
    }
    if (status < 400) return yield* fail(new ToolSourceError.InvalidResponseError({ description }))
    // The API's own words for what is wrong with the request are what the model can act on.
    const said = (yield* readText(response).pipe(Effect.orElseSucceed(() => ""))).trim()
    const excerpt = said.length > maxFailureLength ? `${said.slice(0, maxFailureLength)}...` : said
    return yield* fail(
      new ToolSourceError.CallFailedError({
        description: excerpt === "" ? description : `${status}: ${excerpt}`
      })
    )
  })

  /** What a response with a status that is a success says: the body, as JSON, or as text. */
  const readBody = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    const text = yield* readText(response)
    if (text.length > maxAnswerLength) {
      // The model reads this, so it can ask for less, such as a page or a field.
      return yield* fail(
        new ToolSourceError.CallFailedError({
          description: `The answer is longer than ${maxAnswerLength} characters, which a tool cannot return; ask for less`
        })
      )
    }
    if (text === "") return null
    const mediaType = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
    if (mediaType === "" || mediaType.startsWith("text/")) return text
    if (mediaType === "application/json" || mediaType.endsWith("+json")) {
      return yield* decodeJson(text).pipe(
        Effect.mapError((error) =>
          fail(new ToolSourceError.InvalidResponseError({ description: "The body is not JSON" }), error)
        )
      )
    }
    return yield* fail(
      new ToolSourceError.UnsupportedError({
        description: `The API answered ${mediaType}, which a tool cannot return`
      })
    )
  })

  /** Sends the operation's request with the input, and reads what the API answered. */
  const call = Effect.fnUntraced(function* (operation: Operation, input: Schema.JsonObject) {
    const prepared = yield* Effect.fromResult(prepare(operation.request, input)).pipe(
      Effect.mapError((description) => fail(new ToolSourceError.InvalidInputError({ description })))
    )
    const request = HttpClientRequest.make(operation.request.method)(baseUrl + prepared.path).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json", ...prepared.headers }),
      HttpClientRequest.appendUrlParams(prepared.query),
      (request) => (prepared.body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, prepared.body))
    )
    const response = yield* send(request)
    return response.status >= 200 && response.status < 300 ? yield* readBody(response) : yield* failWithStatus(response)
  })

  const timedOut = Effect.fail(
    fail(
      new ToolSourceError.UnavailableError({
        description: `The API did not answer within ${Duration.toMillis(timeout) / 1000} seconds`
      })
    )
  )

  const source: ToolSource.ToolSource = {
    name,
    discover: Effect.succeed(options.operations.map((operation) => operation.definition)),
    call: (tool, input) => {
      const operation = operations.get(tool)
      if (operation === undefined) return Effect.fail(fail(new ToolSourceError.NotFoundError({})))
      return call(operation, input).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut }))
    }
  }
  return source
})

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** What the model gave, laid out as the places of a request. */
interface Prepared {
  readonly path: string
  readonly query: ReadonlyArray<readonly [string, string]>
  readonly headers: Readonly<Record<string, string>>
  readonly body: Schema.Json | undefined
}

type Scalar = string | number | boolean

const isScalar = (value: Schema.Json): value is Scalar =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** A character that a header value cannot hold, which a value with one could use to add headers. */
const invalidInHeader = /[^\t\x20-\x7e\x80-\xff]/

/**
 * Fills the places of a request with the input, or says what is wrong with the input. A value is
 * a string, a number, or a boolean, and a query or a header may take a list of them. A value in the
 * path is encoded, and may not be empty or stand for a part of the path, since it could otherwise
 * decide which operation of the API is called.
 */
const prepare = (template: RequestTemplate, input: Schema.JsonObject): Result.Result<Prepared, string> => {
  const pathValues = new Map<string, string>()
  const query: Array<readonly [string, string]> = []
  const headers: Record<string, string> = {}

  for (const parameter of template.parameters) {
    const given = input[parameter.property]
    if (given === undefined || given === null) continue
    const values = Array.isArray(given) ? given : [given]
    const listAllowed = parameter.in !== "path"
    if ((Array.isArray(given) && !listAllowed) || !values.every(isScalar)) {
      return Result.fail(
        `\`${parameter.property}\` must be a string, a number, or a boolean${listAllowed ? ", or a list of them" : ""}`
      )
    }
    const texts = values.map(String)
    switch (parameter.in) {
      case "path": {
        const [text] = texts
        if (text === undefined || text === "" || text === "." || text === "..") {
          return Result.fail(`\`${parameter.property}\` must be a name, not "${text}"`)
        }
        pathValues.set(parameter.name, encodeURIComponent(text))
        break
      }
      case "query":
        for (const text of texts) query.push([parameter.name, text])
        break
      case "header": {
        const text = texts.join(",")
        if (invalidInHeader.test(text)) {
          return Result.fail(`\`${parameter.property}\` has a character that a header cannot hold`)
        }
        headers[parameter.name] = text
        break
      }
    }
  }

  const path = template.path.replace(/\{([^{}]+)\}/g, (place, name: string) => pathValues.get(name) ?? place)
  const missing = [...path.matchAll(/\{([^{}]+)\}/g)].map((place) => place[1])
  if (missing.length > 0) {
    const names = template.parameters
      .filter((parameter) => parameter.in === "path" && missing.includes(parameter.name))
      .map((parameter) => `\`${parameter.property}\``)
    return Result.fail(`${names.length > 0 ? names.join(", ") : missing.join(", ")} must be given`)
  }

  return Result.succeed({
    path: path.startsWith("/") ? path : `/${path}`,
    query,
    headers,
    body: template.body === undefined ? undefined : input[template.body]
  })
}
