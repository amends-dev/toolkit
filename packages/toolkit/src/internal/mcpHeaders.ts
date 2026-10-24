/**
 * The headers that MCP's Streamable HTTP transport mirrors from a request's body, so that a load
 * balancer or a firewall can route on them without reading the body.
 *
 * A server may mark a parameter of a tool in its `inputSchema` with `x-mcp-header: "Region"`, and
 * the client then sends the parameter's value as `Mcp-Param-Region` as well as in the body. A server
 * that has marked a parameter refuses a call that sends the value without the header. `Mcp.http`
 * finds the marks when it lists a server's tools, and sends the headers with each call.
 */

import * as Base64 from "effect/encoding/Base64"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"

/**
 * A parameter of a tool that is also sent as a header.
 */
export interface Binding {
  /** What follows `Mcp-Param-` in the name of the header. */
  readonly headerName: string

  /** The names of the properties that lead from the input of the tool to the parameter. */
  readonly path: ReadonlyArray<string>
}

type Json = Schema.Json
type JsonObject = { readonly [key: string]: Json }

const isJsonObject = (value: Json | undefined): value is JsonObject => Predicate.isReadonlyObject(value)

const annotation = "x-mcp-header"

/** HTTP's `token`, which a field name is made of. */
const isToken = (text: string) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text)

/**
 * The types of parameter that can be sent as a header. The protocol leaves out `number`, but the
 * conformance suite of the MCP SDK sends one, and so does the SDK's client, so a tool that marks one
 * is not refused.
 */
const mirroredTypes = ["string", "integer", "number", "boolean"]

/** The keywords whose value is a schema, or a list of them, that no chain of `properties` leads to. */
const schemaKeywords = [
  "items",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "oneOf",
  "anyOf",
  "allOf"
]

/** The keywords whose value holds schemas by name, as `properties` does. */
const namedSchemaKeywords = ["patternProperties", "dependentSchemas", "$defs", "definitions"]

interface Declaration {
  /** `undefined` when no chain of `properties` leads from the root to the schema. */
  readonly path: ReadonlyArray<string> | undefined
  readonly name: Json | undefined
  readonly type: Json | undefined
}

/**
 * The marks in `schema` and in the schemas it holds, each with the path that `properties` lead to it
 * by, if one does. The walk goes only where a keyword holds a schema: a `default` or an `enum` that
 * has the name of the mark in it is a value, and no mark.
 */
const declarationsIn = (
  schema: Json | undefined,
  path: ReadonlyArray<string> | undefined
): ReadonlyArray<Declaration> => {
  if (!isJsonObject(schema)) return []
  const here = Object.hasOwn(schema, annotation) ? [{ path, name: schema[annotation], type: schema["type"] }] : []
  const holders = (keyword: string) => {
    const held = schema[keyword]
    return isJsonObject(held) ? Object.entries(held) : []
  }
  const reached = holders("properties").flatMap(([name, child]) =>
    declarationsIn(child, path === undefined ? undefined : [...path, name])
  )
  const elsewhere = [
    ...schemaKeywords.flatMap((keyword) => {
      const held = schema[keyword]
      return Array.isArray(held) ? held : [held]
    }),
    ...namedSchemaKeywords.flatMap((keyword) => holders(keyword).map(([, child]) => child))
  ].flatMap((child) => declarationsIn(child, undefined))
  return [...here, ...reached, ...elsewhere]
}

/**
 * The parameters that the `inputSchema` of a tool marks as headers, or why the tool is not one a
 * client may use: a client has to leave out a tool whose marks the protocol does not allow, such as
 * a mark on a parameter that is an object, or two of the same name.
 */
export const findBindings = (inputSchema: Schema.JsonObject): Result.Result<ReadonlyArray<Binding>, string> => {
  const bindings: Array<Binding> = []
  for (const declaration of declarationsIn(inputSchema, [])) {
    const { path, name, type } = declaration
    if (path === undefined || path.length === 0) {
      return Result.fail(`${annotation} is only allowed on a property that "properties" lead to from the root`)
    }
    const where = path.join(".")
    if (typeof name !== "string" || !isToken(name)) {
      return Result.fail(`${where}: ${annotation} ${JSON.stringify(name)} is not the name of a header`)
    }
    if (typeof type !== "string" || !mirroredTypes.includes(type)) {
      return Result.fail(`${where}: ${annotation} is only allowed on a string, a number or a boolean`)
    }
    const lowerCased = name.toLowerCase()
    if (bindings.some((binding) => binding.headerName.toLowerCase() === lowerCased)) {
      return Result.fail(`${where}: ${annotation} "${name}" is used by another property`)
    }
    bindings.push({ headerName: name, path })
  }
  return Result.succeed(bindings)
}

const sentinelStart = "=?base64?"
const sentinelEnd = "?="

/**
 * The value of a header that says `text`: the text itself when a header can hold it as it is, or
 * else its UTF-8 as base64 between `=?base64?` and `?=`, for a text with a character that is not
 * printable ASCII, one that ends in a space or a tab, which a header does not keep, or one that is
 * written as the base64 form is.
 */
export const encodeHeaderValue = (text: string): string => {
  const isPlain =
    /^[\x20-\x7E]*$/.test(text) &&
    !/^[ \t]|[ \t]$/.test(text) &&
    !(text.startsWith(sentinelStart) && text.endsWith(sentinelEnd))
  return isPlain ? text : `${sentinelStart}${Base64.encode(text)}${sentinelEnd}`
}

const valueAt = (input: Json, path: ReadonlyArray<string>): Json | undefined => {
  let node: Json | undefined = input
  for (const key of path) {
    if (!isJsonObject(node)) return undefined
    node = node[key]
  }
  return node
}

/** The text a value is sent as, which a value that is not a string, a number, or a boolean has not. */
const textOf = (value: Json | undefined): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return String(value)
  // An integer beyond what a number holds exactly is not the integer that the body says.
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? undefined : String(value)
  }
  return undefined
}

/**
 * The headers to send with a call of a tool, for the parameters it marks. A parameter the input
 * leaves out, or gives as `null`, has none, as the server does not look for one.
 */
export const headersOf = (
  bindings: ReadonlyArray<Binding>,
  input: Schema.JsonObject
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    bindings.flatMap((binding) => {
      const text = textOf(valueAt(input, binding.path))
      return text === undefined ? [] : [[`mcp-param-${binding.headerName.toLowerCase()}`, encodeHeaderValue(text)]]
    })
  )
