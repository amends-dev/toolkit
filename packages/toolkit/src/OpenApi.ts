/**
 * `readOperations` makes the operations `Http` runs from the specification of an HTTP API, which is
 * an OpenAPI 3 document read as JSON. It reads only the document: no reference is fetched, and no
 * address in it is used, since where requests go and what credentials they carry are the host's to
 * say.
 *
 * Each operation becomes a tool whose input has a property for each parameter, named as the
 * parameter is, and a property `body` for the JSON body. An operation that cannot be made a tool, as
 * one with a body that is not JSON, is left out with the reason, so a host can show what it lost.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as JsonPointer from "effect/JsonPointer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import type * as Http from "./Http.ts"
import type * as ToolDefinition from "./ToolDefinition.ts"

/**
 * An operation that was left out of the tools, and why.
 *
 * @category models
 * @since 0.1.0
 */
export interface Skipped {
  /** The operation as the document has it, such as `POST /pets`. */
  readonly operation: string

  /** Why the operation cannot be a tool, such as a body that is not JSON, for a person to read. */
  readonly reason: string
}

/**
 * What `readOperations` reads of a document: the operations that are tools, the addresses of the
 * servers it names, and the operations it left out.
 *
 * @category models
 * @since 0.1.0
 */
export interface Imported {
  /** The operations that are tools, whose names are distinct. */
  readonly operations: ReadonlyArray<Http.Operation>

  /** The addresses the document gives for the API, which the host may offer as its base URL. */
  readonly servers: ReadonlyArray<string>

  /** The operations that are not tools, each with why. */
  readonly skipped: ReadonlyArray<Skipped>
}

/**
 * The document is not an OpenAPI 3 document, so there is nothing to read. An operation that
 * cannot be a tool does not fail the read: it is in `skipped`.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidSpecError extends Schema.TaggedError<InvalidSpecError>(
  "@amends-dev/toolkit/OpenApi/InvalidSpecError"
)("InvalidSpecError", { description: Schema.String }) {
  override get message(): string {
    return this.description
  }
}

type Json = Schema.Json
type Entries = { [key: string]: Json }

const isJsonObject = (value: Json | undefined): value is Schema.JsonObject => Predicate.isReadonlyObject(value)

const objectAt = (object: Schema.JsonObject, key: string) => {
  const value = object[key]
  return isJsonObject(value) ? value : undefined
}

const stringAt = (object: Schema.JsonObject, key: string) => {
  const value = object[key]
  return typeof value === "string" ? value : undefined
}

const methods: ReadonlyArray<Http.Method> = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH"]

/**
 * Reads the operations of the API that `document` specifies, which is JSON already read. Nothing
 * it refers to outside itself is fetched.
 *
 * **Example** (A source of an API, from its OpenAPI document)
 *
 * ```ts
 * import { Http, OpenApi } from "@amends-dev/toolkit"
 * import { Effect, Schema } from "effect"
 * import { FetchHttpClient, HttpClient } from "effect/http"
 *
 * declare const document: Schema.Json // the API's OpenAPI document, read as JSON
 *
 * const program = Effect.gen(function* () {
 *   const { operations, servers, skipped } = yield* OpenApi.readOperations(document)
 *   // An operation that cannot be a tool is in `skipped`, with why, for a person to read.
 *   for (const { operation, reason } of skipped) yield* Effect.logWarning(`${operation}: ${reason}`)
 *   // The document's first server is where its requests go, unless the host says otherwise.
 *   const baseUrl = servers[0] ?? "https://petstore.example.com/api"
 *   const client = yield* HttpClient.HttpClient
 *   const petstore = yield* Http.make({ name: "petstore", baseUrl, client, operations })
 *   return yield* petstore.discover
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const readOperations = (document: Json): Effect.Effect<Imported, InvalidSpecError> =>
  Effect.fromResult(readDocument(document))

const readDocument = (document: Json): Result.Result<Imported, InvalidSpecError> => {
  if (!isJsonObject(document)) return invalid("The document is not an object")
  if ("swagger" in document) {
    return invalid("A Swagger 2.0 document is not supported, so it must be converted to OpenAPI 3")
  }
  const version = stringAt(document, "openapi")
  if (version === undefined || !version.startsWith("3.")) {
    return invalid("The document does not say that it is OpenAPI 3")
  }
  const paths = document["paths"] ?? {}
  if (!isJsonObject(paths)) return invalid("The paths of the document are not an object")

  const operations: Array<Http.Operation> = []
  const skipped: Array<Skipped> = []
  const namesTaken = new Map<string, string>()
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isJsonObject(pathItem) || typeof pathItem["$ref"] === "string") {
      skipped.push({ operation: path, reason: "The path is not described in the document itself" })
      continue
    }
    for (const method of methods) {
      const operation = pathItem[method.toLowerCase()]
      if (!isJsonObject(operation)) continue
      const label = `${method} ${path}`
      const made = readOperation(document, version, method, path, pathItem, operation)
      if (Result.isFailure(made)) {
        skipped.push({ operation: label, reason: made.failure })
        continue
      }
      const name = made.success.definition.name
      const earlier = namesTaken.get(name)
      if (earlier !== undefined) {
        skipped.push({ operation: label, reason: `It has the name of ${earlier}` })
        continue
      }
      namesTaken.set(name, label)
      operations.push(made.success)
    }
  }
  return Result.succeed({ operations, servers: serversOf(document), skipped })
}

const invalid = (description: string) => Result.fail(new InvalidSpecError({ description }))

/** The tool for one operation of the document, or why it cannot be one. */
const readOperation = (
  document: Schema.JsonObject,
  version: string,
  method: Http.Method,
  path: string,
  pathItem: Schema.JsonObject,
  operation: Schema.JsonObject
): Result.Result<Http.Operation, string> =>
  Result.gen(function* () {
    const schemas = schemaConverter(document, version.startsWith("3.0"))
    const parameters = yield* readParameters(document, schemas, pathItem, operation)
    const body = yield* readBody(document, schemas, operation)
    const pathProblem = checkPath(path, parameters)
    if (pathProblem !== undefined) return yield* Result.fail(pathProblem)

    const named = nameProperties(parameters, body !== undefined)
    const properties: Entries = {}
    const required: Array<string> = []
    for (const { property, schema, isRequired } of named) {
      properties[property] = schema
      if (isRequired) required.push(property)
    }
    if (body !== undefined) {
      properties["body"] = body.schema
      if (body.isRequired) required.push("body")
    }
    const [problem] = schemas.problems
    if (problem !== undefined) return yield* Result.fail(problem)

    const title = stringAt(operation, "summary")
    return {
      definition: {
        name: stringAt(operation, "operationId") ?? nameOf(method, path),
        ...describe(title, stringAt(operation, "description")),
        inputSchema: {
          type: "object",
          properties: properties as Record<string, Schema.JsonObject>,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
          ...(Object.keys(schemas.defs).length > 0 ? { $defs: schemas.defs } : {})
        },
        annotations: annotationsOf(method, title)
      },
      request: {
        method,
        path,
        parameters: named.map(({ in: place, name, property }) => ({ in: place, name, property })),
        ...(body === undefined ? {} : { body: "body" })
      }
    }
  })

interface ParameterRead {
  readonly in: Http.Parameter["in"]
  readonly name: string
  readonly schema: Schema.JsonObject
  readonly isRequired: boolean
}

const ParameterObject = Schema.Struct({
  name: Schema.NonEmptyString,
  in: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(Schema.String),
  explode: Schema.optionalKey(Schema.Boolean),
  schema: Schema.optionalKey(Schema.Json),
  content: Schema.optionalKey(Schema.Json)
})

const isParameter = Schema.is(ParameterObject)

/** Headers that the document does not decide, as OpenAPI says: a client does. */
const ignoredHeaders = new Set(["accept", "content-type", "authorization"])

/** The parameters of the operation, which override those of its path of the same place and name. */
const readParameters = (
  document: Schema.JsonObject,
  schemas: SchemaConverter,
  pathItem: Schema.JsonObject,
  operation: Schema.JsonObject
): Result.Result<ReadonlyArray<ParameterRead>, string> => {
  const listed = [pathItem["parameters"], operation["parameters"]].flatMap((list) => (Array.isArray(list) ? list : []))
  const byPlace = new Map<string, ParameterRead>()
  for (const item of listed) {
    const parameter = dereference(document, item)
    if (!isParameter(parameter)) return Result.fail("A parameter is not as OpenAPI says")
    const place = `${parameter.in}:${parameter.name}`
    if (parameter.in === "cookie") {
      if (parameter.required === true) return Result.fail(`\`${parameter.name}\` is a cookie`)
      continue
    }
    if (parameter.in !== "path" && parameter.in !== "query" && parameter.in !== "header") {
      return Result.fail(`\`${parameter.name}\` is in ${parameter.in}`)
    }
    if (parameter.in === "header" && ignoredHeaders.has(parameter.name.toLowerCase())) continue
    if (parameter.content !== undefined) {
      return Result.fail(`\`${parameter.name}\` is described by its content`)
    }
    const problem = serializationProblem(document, parameter)
    if (problem !== undefined) return Result.fail(problem)

    const converted = schemas.convert(parameter.schema ?? { type: "string" })
    const schema = isJsonObject(converted) ? converted : {}
    byPlace.set(place, {
      in: parameter.in,
      name: parameter.name,
      schema:
        parameter.description === undefined || "description" in schema
          ? schema
          : Struct.assign(schema, { description: parameter.description }),
      isRequired: parameter.in === "path" || parameter.required === true
    })
  }
  return Result.succeed([...byPlace.values()])
}

/**
 * Why a parameter cannot be sent as the tool sends it: its value is a string, a number, a boolean,
 * or a list of them (not in the path), written as OpenAPI writes it by default.
 */
const serializationProblem = (
  document: Schema.JsonObject,
  parameter: typeof ParameterObject.Type
): string | undefined => {
  const kinds =
    parameter.in === "path" ? "a string, a number, or a boolean" : "a string, a number, a boolean, or a list of them"
  const defaultStyle = parameter.in === "query" ? "form" : "simple"
  if (parameter.style !== undefined && parameter.style !== defaultStyle) {
    return `\`${parameter.name}\` is written in the style ${parameter.style}`
  }
  if (parameter.in === "query" && parameter.explode === false) {
    return `\`${parameter.name}\` is a list in one value`
  }
  const schema = dereference(document, parameter.schema)
  if (!isJsonObject(schema)) return undefined
  const isList = schema["type"] === "array"
  const items = isList ? dereference(document, schema["items"]) : undefined
  if (
    schema["type"] === "object" ||
    isJsonObject(schema["properties"]) ||
    (isList &&
      (parameter.in === "path" || !isJsonObject(items) || items["type"] === "object" || items["type"] === "array"))
  ) {
    return `\`${parameter.name}\` is not ${kinds}`
  }
  return undefined
}

interface BodyRead {
  readonly schema: Schema.JsonObject
  readonly isRequired: boolean
}

/** The JSON body of the operation, if it has one, or why a body it has cannot be sent. */
const readBody = (
  document: Schema.JsonObject,
  schemas: SchemaConverter,
  operation: Schema.JsonObject
): Result.Result<BodyRead | undefined, string> => {
  const body = dereference(document, operation["requestBody"])
  if (!isJsonObject(body)) return Result.succeed(undefined)
  const content = objectAt(body, "content") ?? {}
  const types = Object.keys(content)
  if (types.length === 0) return Result.succeed(undefined)
  const mediaType = types.find((type) => isJsonType(type))
  if (mediaType === undefined) {
    return Result.fail(`The body is ${types.join(" or ")}, and only JSON is supported`)
  }
  const converted = schemas.convert(objectAt(content, mediaType)?.["schema"] ?? {})
  return Result.succeed({
    schema: isJsonObject(converted) ? converted : {},
    isRequired: body["required"] === true
  })
}

const isJsonType = (type: string) => {
  const mediaType = type.split(";")[0]?.trim().toLowerCase() ?? ""
  return mediaType === "application/json" || mediaType.endsWith("+json")
}

/** The path and its parameters must name the same places. */
const checkPath = (path: string, parameters: ReadonlyArray<ParameterRead>): string | undefined => {
  const places = [...path.matchAll(/\{([^{}]+)\}/g)].map((place) => place[1])
  const declared = parameters.filter((parameter) => parameter.in === "path").map((p) => p.name)
  const without = places.find((place) => place !== undefined && !declared.includes(place))
  if (without !== undefined) return `The path has {${without}}, which no parameter describes`
  const unused = declared.find((name) => !places.includes(name))
  if (unused !== undefined) return `\`${unused}\` is a path parameter that the path does not have`
  return undefined
}

interface NamedParameter extends ParameterRead {
  readonly property: string
}

/**
 * Names the input's properties: as the parameters are, in the characters and the length agents accept,
 * and with the place put before the name when two would have one, or when one is `body`.
 */
const nameProperties = (parameters: ReadonlyArray<ParameterRead>, hasBody: boolean): ReadonlyArray<NamedParameter> => {
  const safe = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64)
  const count = (name: string) =>
    parameters.filter((parameter) => safe(parameter.name) === name).length + (hasBody && name === "body" ? 1 : 0)
  return parameters.map((parameter) => ({
    ...parameter,
    property: count(safe(parameter.name)) > 1 ? safe(`${parameter.in}_${parameter.name}`) : safe(parameter.name)
  }))
}

/** The name of an operation that has none: its method, and the words of its path. */
const nameOf = (method: Http.Method, path: string) =>
  [method.toLowerCase(), path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")]
    .filter((word) => word !== "")
    .join("_")

const describe = (summary: string | undefined, description: string | undefined) => {
  const parts = [summary, description].filter(
    (part, index, all): part is string => part !== undefined && part !== "" && all.indexOf(part) === index
  )
  return parts.length === 0 ? {} : { description: parts.join("\n\n") }
}

/**
 * What HTTP says of a method, which is all the document says of what an operation does: a safe method
 * changes nothing, and some are safe to repeat. A hint left out means Effect AI's default for it.
 */
const annotationsOf = (method: Http.Method, title: string | undefined): ToolDefinition.Annotations => ({
  ...(title === undefined ? {} : { title }),
  readOnly: method === "GET" || method === "HEAD" || method === "OPTIONS",
  idempotent: method !== "POST" && method !== "PATCH",
  ...(method === "DELETE" ? { destructive: true } : {})
})

/** The addresses of the servers the document names, with the variables in them given their defaults. */
const serversOf = (document: Schema.JsonObject): ReadonlyArray<string> => {
  const servers = Array.isArray(document["servers"]) ? document["servers"] : []
  const urls = servers.flatMap((server) => {
    if (!isJsonObject(server)) return []
    const url = stringAt(server, "url")
    if (url === undefined) return []
    const variables = objectAt(server, "variables") ?? {}
    return [
      url.replace(/\{([^{}]+)\}/g, (place, name: string) => {
        const variable = objectAt(variables, name)
        return (variable === undefined ? undefined : stringAt(variable, "default")) ?? place
      })
    ]
  })
  return [...new Set(urls)]
}

/**
 * The names a reference to a place in the document goes through, as a JSON pointer writes them.
 * Laxer than a URI fragment: documents write characters a URI escapes, such as spaces, as they are.
 */
const pathOf = (reference: string): ReadonlyArray<string> | undefined => {
  if (!reference.startsWith("#/")) return undefined
  try {
    return reference
      .slice(2)
      .split("/")
      .map((token) => JsonPointer.unescapeToken(decodeURIComponent(token)))
  } catch {
    return undefined
  }
}

/** The value a reference in the document points to, which is a path within the document itself. */
const resolve = (document: Schema.JsonObject, reference: string): Json | undefined => {
  const path = pathOf(reference)
  if (path === undefined) return undefined
  let node: Json | undefined = document
  for (const key of path) {
    if (!isJsonObject(node)) return undefined
    node = node[key]
  }
  return node
}

/** What `node` is, or what it points to when it is a reference, and so on, up to a limit. */
const dereference = (document: Schema.JsonObject, node: Json | undefined): Json | undefined => {
  let current = node
  for (let hops = 0; hops < 20; hops++) {
    if (!isJsonObject(current) || typeof current["$ref"] !== "string") return current
    current = resolve(document, current["$ref"])
  }
  return undefined
}

interface SchemaConverter {
  /** The schema as JSON Schema 2020-12 has it, with its references into `defs`. */
  readonly convert: (schema: Json) => Json

  /** The schemas of the document that the converted schemas refer to. */
  readonly defs: Entries

  /** What is not supported in the schemas converted, which a reference outside the document is. */
  readonly problems: Array<string>
}

/**
 * Converts the schemas of one operation, which is made of what they refer to, so a tool's input
 * stands alone. A schema of OpenAPI 3.0 is made as 3.1 has it: `nullable` and the exclusive limits
 * of a number are written differently, and the rest is the same, since a keyword that is not known
 * is not an error in a schema.
 */
const schemaConverter = (document: Schema.JsonObject, isVersion30: boolean): SchemaConverter => {
  const defs: Entries = {}
  const keys = new Map<string, string>()
  const problems: Array<string> = []

  const refer = (reference: string): string => {
    const [components, kind, name, ...deeper] = pathOf(reference) ?? []
    const isSchema =
      components === "components" &&
      kind === "schemas" &&
      name !== undefined &&
      deeper.length === 0 &&
      resolve(document, reference) !== undefined
    if (!isSchema) {
      problems.push(`The schema refers to ${reference}, which is not a schema of the document`)
      return reference
    }
    const existing = keys.get(name)
    if (existing !== undefined) return `#/$defs/${existing}`
    const base = name.replace(/[^A-Za-z0-9_.-]/g, "_")
    let key = base
    for (let suffix = 2; key in defs; suffix++) key = `${base}_${suffix}`
    keys.set(name, key)
    // Taken before it is converted, so that a schema it refers to cannot take the same key.
    defs[key] = {}
    defs[key] = convert(resolve(document, reference) ?? {})
    return `#/$defs/${key}`
  }

  const convertKeyword = (key: string, value: Json): Json => {
    switch (key) {
      case "$ref":
        return typeof value === "string" ? refer(value) : value
      case "properties":
      case "patternProperties":
      case "dependentSchemas":
        return isJsonObject(value)
          ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, convert(schema)]))
          : value
      case "items":
      case "additionalProperties":
      case "unevaluatedProperties":
      case "not":
      case "contains":
      case "propertyNames":
      case "if":
      case "then":
      case "else":
        return convert(value)
      case "allOf":
      case "anyOf":
      case "oneOf":
      case "prefixItems":
        return Array.isArray(value) ? value.map(convert) : value
      default:
        return value
    }
  }

  const convert = (schema: Json): Json => {
    if (!isJsonObject(schema)) return schema
    const converted: Entries = {}
    for (const [key, value] of Object.entries(schema)) converted[key] = convertKeyword(key, value)
    return isVersion30 ? upgradeFrom30(converted) : converted
  }

  return { convert, defs, problems }
}

/** A schema of OpenAPI 3.0, as 3.1 writes it. */
const upgradeFrom30 = (schema: Entries): Entries => {
  const upgraded: Entries = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "nullable") continue
    // 3.0 makes a limit exclusive with a boolean beside it, and 3.1 with the limit as the number.
    if (key === "minimum" && schema["exclusiveMinimum"] === true) continue
    if (key === "maximum" && schema["exclusiveMaximum"] === true) continue
    if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
      const limit = schema[key === "exclusiveMinimum" ? "minimum" : "maximum"]
      if (value === true && typeof limit === "number") upgraded[key] = limit
      continue
    }
    upgraded[key] = value
  }
  if (schema["nullable"] !== true) return upgraded
  const type = upgraded["type"]
  if (typeof type === "string" || Array.isArray(type)) {
    upgraded["type"] = [...(Array.isArray(type) ? type : [type]), "null"]
    const values = upgraded["enum"]
    if (Array.isArray(values) && !values.includes(null)) upgraded["enum"] = [...values, null]
    return upgraded
  }
  return { anyOf: [upgraded, { type: "null" }] }
}
