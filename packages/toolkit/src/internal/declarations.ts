/**
 * TypeScript declarations of a set of tools, for a model to write code against: the tools as the
 * methods of one object, `tools`, each taking its input as an object and answering with a promise. A
 * model reads a type faster and writes to it better than it reads the JSON Schema it comes from.
 *
 * Only what a type can say is kept: the shape of the input, which properties are required, the
 * values an enum allows, and the descriptions, as comments. A schema that is cyclic, or nested
 * more than six levels deep, ends in `unknown`, as does any keyword this does not read.
 * `CodeMode.toolkit` shows them to the model in the description of `execute`.
 */

import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/**
 * A tool as `declare` takes it: its name, what it does, and its input's JSON Schema.
 */
export interface Declared {
  readonly name: string
  readonly description?: string | undefined

  /** The tool's input, as a JSON Schema with an object root. */
  readonly inputSchema: Schema.JsonObject
}

/** How deep an input may nest before its type ends in `unknown`, to keep what a model reads short. */
const maxDepth = 6

/**
 * The declaration of `tools`, as the type of the object the code reads them from. Each tool is a
 * method that takes its input and answers with `Promise<unknown>`, and whose input is optional
 * when its schema requires nothing.
 */
export const declare = (tools: ReadonlyArray<Declared>): string =>
  [
    "declare const tools: {",
    ...tools.map((tool) => {
      const input = typeOf(tool.inputSchema, { root: tool.inputSchema, path: [], depth: 0 }, "  ")
      const inputIsOptional = !hasRequired(tool.inputSchema)
      return [
        ...commentOf(tool.description, "  "),
        `  ${propertyKey(tool.name)}(input${inputIsOptional ? "?" : ""}: ${input}): Promise<unknown>;`
      ].join("\n")
    }),
    "};"
  ].join("\n")

interface Scope {
  /** The schema that `$ref`s are resolved in. */
  readonly root: Schema.JsonObject

  /** The references being resolved, to tell a cycle. */
  readonly path: ReadonlyArray<string>
  readonly depth: number
}

const isJsonObject = (json: Schema.Json | undefined): json is Schema.JsonObject => Predicate.isReadonlyObject(json)

const hasRequired = (schema: Schema.JsonObject) => Array.isArray(schema.required) && schema.required.length > 0

/** The type of `schema`, written at `indent`. */
const typeOf = (schema: Schema.Json, scope: Scope, indent: string): string => {
  if (schema === true) return "unknown"
  if (schema === false) return "never"
  if (!isJsonObject(schema) || scope.depth > maxDepth) return "unknown"
  if (typeof schema.$ref === "string") return referenceType(schema.$ref, scope, indent)
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value)))
  const deeper = { ...scope, depth: scope.depth + 1 }
  if (Array.isArray(schema.anyOf)) {
    return union(schema.anyOf.map((member) => typeOf(member, deeper, indent)))
  }
  if (Array.isArray(schema.oneOf)) {
    return union(schema.oneOf.map((member) => typeOf(member, deeper, indent)))
  }
  if (Array.isArray(schema.allOf)) {
    return intersection(schema.allOf.map((member) => typeOf(member, deeper, indent)))
  }
  const kinds = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === "string"
      ? [schema.type]
      : [schema.properties === undefined ? (schema.items === undefined ? "" : "array") : "object"]
  return union(kinds.map((kind) => kindType(kind, schema, deeper, indent)))
}

/** The type of what a `$ref` of the schema's own `$defs` or `definitions` names. */
const referenceType = (reference: string, scope: Scope, indent: string) => {
  const [, container, name] = /^#\/(\$defs|definitions)\/(.+)$/.exec(reference) ?? []
  const defs = container === undefined ? undefined : scope.root[container]
  const target = name === undefined || !isJsonObject(defs) ? undefined : defs[name]
  if (target === undefined || scope.path.includes(reference)) return "unknown"
  return typeOf(target, { ...scope, path: [...scope.path, reference] }, indent)
}

const kindType = (kind: Schema.Json, schema: Schema.JsonObject, scope: Scope, indent: string) => {
  switch (kind) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return arrayType(schema, scope, indent)
    case "object":
      return objectType(schema, scope, indent)
    default:
      return "unknown"
  }
}

const arrayType = (schema: Schema.JsonObject, scope: Scope, indent: string) => {
  if (Array.isArray(schema.prefixItems)) {
    return `[${schema.prefixItems.map((item) => typeOf(item, scope, indent)).join(", ")}]`
  }
  return `Array<${schema.items === undefined ? "unknown" : typeOf(schema.items, scope, indent)}>`
}

const objectType = (schema: Schema.JsonObject, scope: Scope, indent: string) => {
  const properties = isJsonObject(schema.properties) ? Object.entries(schema.properties) : []
  const additional = schema.additionalProperties
  const additionalType =
    additional === undefined || additional === false ? undefined : typeOf(additional, scope, indent)
  if (properties.length === 0) return `Record<string, ${additionalType ?? "unknown"}>`
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const inner = `${indent}  `
  return [
    "{",
    ...properties.flatMap(([name, property]) => [
      ...commentOf(isJsonObject(property) ? property.description : undefined, inner),
      `${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${typeOf(property, scope, inner)};`
    ]),
    ...(additionalType === undefined ? [] : [`${inner}[key: string]: ${additionalType};`]),
    `${indent}}`
  ].join("\n")
}

const union = (members: ReadonlyArray<string>) => {
  const distinct = [...new Set(members)]
  return distinct.length === 0 ? "never" : distinct.join(" | ")
}

const intersection = (members: ReadonlyArray<string>) =>
  members.length === 0
    ? "unknown"
    : members.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ")

/** The name as a property of an object type, quoted when it is not an identifier. */
const propertyKey = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name))

/** A comment of `description` at `indent`, which cannot end early. */
const commentOf = (description: Schema.Json | undefined, indent: string): ReadonlyArray<string> => {
  if (typeof description !== "string" || description.trim() === "") return []
  const lines = description.trim().replaceAll("*/", "* /").split(/\r?\n/)
  return lines.length === 1
    ? [`${indent}/** ${lines[0]} */`]
    : [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`]
}
