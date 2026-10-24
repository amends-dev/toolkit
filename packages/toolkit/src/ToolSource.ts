/**
 * A tool source is a system that tells which tools it has and runs them, such as an MCP server or an
 * HTTP API. Each kind implements `ToolSource`, and `toolkit` builds from it the Effect AI toolkit a
 * model calls: a dynamic tool for each definition, whose handler checks the model's input against the
 * tool's parameters, asks the source to run the tool, and turns whatever happens into a tool result.
 *
 * Building a toolkit contacts nothing. The definitions come from the caller, who has them from a
 * catalog, and the source is reached only when the model calls a tool. `discover` is for the catalog,
 * which asks the source what it has now and decides what its tools may do before any of them is
 * built into a toolkit.
 *
 * A call that fails is a result the model reads, so the turn goes on and the model can try something
 * else. Only interrupting the call ends it in any other way.
 *
 * @since 0.1.0
 */

import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import type * as ToolDefinition from "./ToolDefinition.ts"
import * as ToolSourceError from "./ToolSourceError.ts"

/**
 * What every kind of tool source implements: its name, the tools it has now, and how to run one.
 * `Mcp.http` and `Http.make` make one, and `toolkit` builds from one the toolkit a model calls.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolSource {
  /**
   * Names the source, such as `github`. Its failures carry the name, and the toolkit of a set of
   * sources is told apart by it.
   */
  readonly name: string

  /** Asks the source which tools it has now. */
  readonly discover: Effect.Effect<ReadonlyArray<ToolDefinition.ToolDefinition>, ToolSourceError.ToolSourceError>

  /**
   * Runs the tool of this name, as `discover` names it, with `input`, an object that matches the
   * tool's parameters, and returns what the tool answers.
   */
  readonly call: (tool: string, input: Schema.JsonObject) => Effect.Effect<Schema.Json, ToolSourceError.ToolSourceError>
}

/**
 * What a model reads of a call that failed: the failure's reason, what the model is told of it, and
 * whether trying again may help. `Presentation`, `ToolSearch`, and `CodeMode` give their own
 * failures in this shape too.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Failure = Schema.Struct({
  /** The reason of the failure, such as `AuthenticationError`. */
  code: Schema.String,

  /** What the model is told of the failure, such as a reason's `modelMessage`. */
  message: Schema.String,

  /** Whether trying the call again may succeed. */
  retryable: Schema.Boolean
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Failure extends Schema.Schema.Type<typeof Failure> {}

/**
 * Builds the toolkit for exactly these `definitions`, which must have distinct names, as a catalog
 * keyed by them has. Its tools are named as the definitions name them. A tool that `needsApproval`
 * names is one the session asks about before it runs the tool.
 *
 * Building contacts nothing: the source is reached only when the model calls a tool.
 *
 * **Example** (The tools of a source, given to a model)
 *
 * ```ts
 * import { ToolSource } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/ai"
 *
 * declare const github: ToolSource.ToolSource // from Mcp.http or Http.make
 *
 * const program = Effect.gen(function* () {
 *   // The definitions come from the host's catalog, which `discover` fills when it refreshes.
 *   const definitions = yield* github.discover
 *   const toolkit = yield* ToolSource.toolkit(github, definitions, {
 *     needsApproval: (definition) => definition.annotations.readOnly !== true
 *   })
 *   // The model calls a tool by the name the source gave it, and reads a failure as a result.
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Which issues of amends-dev/amends are open?",
 *     toolkit
 *   })
 *   return response.text
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolkit = Effect.fn("ToolSource.toolkit")(function* (
  source: ToolSource,
  definitions: ReadonlyArray<ToolDefinition.ToolDefinition>,
  options?: { readonly needsApproval?: (definition: ToolDefinition.ToolDefinition) => boolean }
) {
  const names = new Set(definitions.map((definition) => definition.name))
  if (names.size !== definitions.length) {
    return yield* Effect.die(new Error(`${source.name} has more than one tool of the same name`))
  }
  const toolkit = Toolkit.make(
    ...definitions.map((definition) => toolOf(definition, options?.needsApproval?.(definition) === true))
  )
  const handlers = Object.fromEntries(definitions.map((definition) => [definition.name, handlerOf(source, definition)]))
  return yield* toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)))
})

/** The dynamic tool for `definition`, without a handler, with the hints its source gave. */
const toolOf = (definition: ToolDefinition.ToolDefinition, needsApproval: boolean) => {
  const tool = Tool.dynamic(definition.name, {
    description: definition.description,
    parameters: definition.inputSchema,
    success: Schema.Json,
    failure: Failure,
    // A failure is a result the model reads, not a failure of the turn.
    failureMode: "return"
  }).annotateMerge(annotationsOf(definition.annotations))
  return needsApproval ? tool.setNeedsApproval(true) : tool
}

/**
 * The annotations of the hints a source gave, so a hint it left out keeps Effect AI's default, and
 * no strict schema mode: the parameters are the source's, which may leave a property optional as
 * strict mode does not allow, and a call checks the input before the source sees it.
 */
const annotationsOf = (hints: ToolDefinition.Annotations) =>
  Context.empty().pipe(
    Context.add(Tool.Strict, false),
    Context.addOrOmit(Tool.Title, Option.fromUndefinedOr(hints.title)),
    Context.addOrOmit(Tool.Readonly, Option.fromUndefinedOr(hints.readOnly)),
    Context.addOrOmit(Tool.Destructive, Option.fromUndefinedOr(hints.destructive)),
    Context.addOrOmit(Tool.Idempotent, Option.fromUndefinedOr(hints.idempotent)),
    Context.addOrOmit(Tool.OpenWorld, Option.fromUndefinedOr(hints.openWorld))
  )

/** Runs the tool `definition` describes when the model calls it, as the source does. */
const handlerOf = (source: ToolSource, definition: ToolDefinition.ToolDefinition) => {
  const validate = inputValidatorOf(source.name, definition)
  return (input: unknown) =>
    validate(input).pipe(
      Effect.flatMap((valid) => source.call(definition.name, valid)),
      // A defect is a bug in the source's code, which the model cannot do anything about. It is
      // reported, and the model reads that the source failed; only an interruption goes on as one.
      Effect.catchDefect((defect) => failedWith(source.name, defect)),
      Effect.mapError(failureOf)
    )
}

/** What the model reads of `error`. */
const failureOf = (error: ToolSourceError.ToolSourceError): Failure => ({
  code: error.reason._tag,
  message: error.reason.modelMessage,
  retryable: error.reason.isRetryable
})

/** Reports `defect` and fails as the source, without what it said, which the model does not read. */
const failedWith = (source: string, defect: unknown) => {
  const cause = Cause.die(defect)
  return Effect.logError(cause).pipe(
    Effect.andThen(ErrorReporter.report(cause)),
    Effect.andThen(
      Effect.fail(
        new ToolSourceError.ToolSourceError({
          source,
          reason: new ToolSourceError.UnknownError({})
        })
      )
    )
  )
}

/**
 * Checks that the model's input is an object that matches the definition's parameters, and returns
 * it as it is. A parameter schema that Effect AI cannot translate to a check, such as one with a
 * `contains` keyword, is checked for being an object only, and the source holds the input to the
 * rest. `format` and `pattern` are not checked, as the source checks them too, and a pattern a source
 * names is not run here.
 */
const inputValidatorOf = (source: string, definition: ToolDefinition.ToolDefinition) => {
  const parameters = checkOfParameters(definition)
  return (input: unknown) =>
    Schema.decodeUnknownEffect(Schema.JsonObject)(input).pipe(
      Effect.tap(parameters),
      Effect.mapError(
        (cause) =>
          new ToolSourceError.ToolSourceError({
            source,
            reason: new ToolSourceError.InvalidInputError({ description: describe(cause.message) }),
            cause
          })
      )
    )
}

/** The check of the definition's parameters, which accepts any input when there is none. */
const checkOfParameters = (definition: ToolDefinition.ToolDefinition) => {
  try {
    // A schema made from JSON Schema keywords decodes with no services, which its type, `Top`,
    // cannot say.
    const schema = SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12(definition.inputSchema),
      { patterns: "ignore" }
    ) as Schema.Codec<unknown>
    return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })
  } catch {
    return () => Effect.void
  }
}

/** A schema error on one line, as `Expected string at ["text"]`. */
const describe = (message: string) => message.replace(/\s*\n\s*/g, " ")
