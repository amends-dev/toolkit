/**
 * A tool definition is a tool as data: what a model is told about a tool, in a form a catalog can
 * store as JSON and a source can report before anything runs the tool. Effect AI's `Tool` is the
 * tool at runtime, with a handler. A definition keeps the tool's parameters as the JSON Schema its
 * source gave, since a tool that a source such as an MCP server lists has no Effect schema, and a
 * JSON Schema is what an agent reads in any case.
 *
 * @since 0.1.0
 */

import * as McpSchema from "effect/ai/McpSchema"
import * as Schema from "effect/Schema"

/**
 * What a source says about a tool besides what it takes, under the names Effect AI gives its tool
 * annotations. They are the source's claims, hints and not guarantees, so a decision about what a
 * tool may do must not rest on them alone. A hint left out means Effect AI's default for it: the
 * tool writes (`readOnly` false), may destroy (`destructive` true), is not safe to repeat
 * (`idempotent` false), and reaches beyond the system it belongs to (`openWorld` true). Only a tool
 * that is not read only can be destructive or idempotent.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Annotations = Schema.Struct({
  /** A name for people to read. */
  title: Schema.optionalKey(Schema.String),

  /** The tool changes nothing. */
  readOnly: Schema.optionalKey(Schema.Boolean),

  /** The tool may destroy or overwrite what it changes, rather than only add to it. */
  destructive: Schema.optionalKey(Schema.Boolean),

  /** Calling the tool again with the same params has no further effect. */
  idempotent: Schema.optionalKey(Schema.Boolean),

  /** The tool reaches beyond the system it belongs to, such as the web, rather than a closed one. */
  openWorld: Schema.optionalKey(Schema.Boolean)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Annotations extends Schema.Schema.Type<typeof Annotations> {}

/**
 * A tool as data: its name, what it does, its parameters as JSON Schema, and its source's hints.
 * A source reports these from `discover`, a catalog stores them as JSON, and
 * `ToolSource.toolkit` and `Assembly.toolkit` build from them the tools a model calls.
 *
 * **Example** (A catalog of a source's tools, stored as JSON)
 *
 * ```ts
 * import { ToolDefinition, type ToolSource } from "@amends-dev/toolkit"
 * import { Effect, Schema } from "effect"
 *
 * declare const github: ToolSource.ToolSource
 * declare const store: (catalog: string) => Effect.Effect<void>
 *
 * const CatalogJson = Schema.fromJsonString(Schema.toCodecJson(Schema.Array(ToolDefinition.ToolDefinition)))
 *
 * // Refreshing the catalog asks the source what it has now, and stores it for the turns to come.
 * const refresh = github.discover.pipe(Effect.flatMap(Schema.encodeEffect(CatalogJson)), Effect.flatMap(store))
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const ToolDefinition = Schema.Struct({
  /** The source's own name for the tool, which is how the source is asked to run it. */
  name: Schema.NonEmptyString,

  /** What the tool does, for the model to decide when to call it. */
  description: Schema.optionalKey(Schema.String),

  /**
   * The tool's parameters, as the JSON Schema with an object root that Effect AI's MCP module
   * uses, and that every agent requires of a tool's parameters. Keywords beyond the ones it names,
   * such as `$defs`, are kept.
   */
  inputSchema: McpSchema.ToolJson,

  /** What the source says of the tool besides what it takes, which are hints and not guarantees. */
  annotations: Annotations
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface ToolDefinition extends Schema.Schema.Type<typeof ToolDefinition> {}
