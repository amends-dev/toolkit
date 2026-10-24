/**
 * Code mode presents a toolkit to a model as one tool, `execute`, which runs code the model writes.
 * The code calls the tools of the presented toolkit as functions, `await tools.<name>(input)`, so a
 * model does in one run what takes it many calls otherwise: it calls a tool, reads the result in
 * code, and filters it or goes on with the next call, and only what the code returns comes back to
 * the model. What it is shown is the same however many tools there are, and costs the tokens of their
 * declarations.
 *
 * Running code is the job of a `CodeRuntime`, which this package does not have: it takes an
 * isolate that cannot reach anything but the tools it is given, and an adapter that has one
 * implements the interface, as `@amends-dev/codemode-opencode` does over opencode's interpreter.
 * Everything else is here. A tool the code calls runs as it does when a model calls it directly, so
 * its input is checked and its failures are what it says. The code fails when it throws, runs too
 * long, or returns too much, and the model reads that.
 *
 * A tool that needs approval cannot be called from code, which a session cannot ask a person about
 * in the middle of a run. It stays a tool of its own beside `execute`, and a session asks about its
 * calls as it does for any tool.
 *
 * @since 0.1.0
 */

import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { declare } from "./internal/declarations.ts"
import * as Presentation from "./Presentation.ts"
import * as ToolSource from "./ToolSource.ts"

/**
 * Why code did not finish: it threw, or the runtime could not run it. A `CodeRuntime` fails with
 * it, and the model reads it as a `Failure` with what the code logged before.
 *
 * @category errors
 * @since 0.1.0
 */
export class CodeError extends Schema.TaggedError<CodeError>("@amends-dev/toolkit/CodeMode/CodeError")("CodeError", {
  /** What went wrong, which the model reads, such as the message of what the code threw. */
  description: Schema.String,

  /** What the code logged before it failed. */
  logs: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return this.description
  }
}

/**
 * One run of code, which a `CodeRuntime` carries out.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution {
  /** The code, as the body of an async function, which `return`s what the run gives back. */
  readonly code: string

  /** The names of the tools the code may call, as `tools.<name>`, which any other name is not. */
  readonly tools: ReadonlyArray<string>

  /**
   * Calls a tool with an input object, which the code gave or left empty, and answers with what the
   * tool gave, or fails as the tool failed. The code reads a failure as an error it can catch.
   */
  readonly call: (tool: string, input: Schema.JsonObject) => Effect.Effect<Schema.Json, ToolSource.Failure>
}

/**
 * What a run gave back, which is what the model reads of `execute` when the code finishes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Outcome = Schema.Struct({
  /** What the code returned, which is `null` when it returned nothing. */
  result: Schema.Json,

  /** What the code logged, a line for each call of `console.log`. */
  logs: Schema.Array(Schema.String)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

/**
 * Runs code in an isolate that can reach nothing but the tools of the execution, which it gives
 * the code as `tools`, beside `console`. An adapter that has such an isolate implements it, as
 * `@amends-dev/codemode-opencode` does; this package does not.
 *
 * @category models
 * @since 0.1.0
 */
export interface CodeRuntime {
  /**
   * Runs the code, and ends the run when interrupted. It fails with `CodeError` when the code
   * throws, and for anything else that stops the run, such as a runtime that cannot start.
   */
  readonly run: (execution: Execution) => Effect.Effect<Outcome, CodeError>
}

/**
 * What `toolkit` takes besides the toolkit it presents and the runtime.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** How long a run may take, which its tool calls count in. A minute by default. */
  readonly timeout?: Duration.Input

  /** The most characters of JSON a run may return. 50,000 by default. */
  readonly maxResultLength?: number
}

const defaultMaxResultLength = 50_000

/** The tool that has the model's code run. A tool of the presented toolkit may not have its name. */
const executeName = "execute"

/**
 * Makes the toolkit of `execute`, and the tools of `presented` that need approval, over `presented`
 * and the runtime that runs the code. Building contacts nothing.
 *
 * **Example** (Presenting tools as code the model writes)
 *
 * ```ts
 * import { Assembly, CodeMode } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 *
 * declare const members: ReadonlyArray<Assembly.Member>
 * declare const runtime: CodeMode.CodeRuntime // an isolate that reaches only the tools it is given
 *
 * const program = Effect.gen(function* () {
 *   const assembled = yield* Assembly.toolkit(members, (_source, definition) =>
 *     definition.annotations.readOnly === true ? "allow" : "approve"
 *   )
 *   // The model is shown `execute`, which calls the read-only tools as `await tools.<name>(input)`,
 *   // and each tool that needs approval as a tool of its own.
 *   return yield* CodeMode.toolkit(assembled, runtime, { timeout: "30 seconds" })
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolkit = Effect.fn("CodeMode.toolkit")(function* <Tools extends Record<string, Tool.Any>>(
  presented: Toolkit.WithHandler<Tools>,
  runtime: CodeRuntime,
  options?: Options
) {
  const services = yield* Effect.context<Tool.HandlerServices<Tools[keyof Tools]>>()
  const timeout = options?.timeout ?? "1 minute"
  const maxResultLength = options?.maxResultLength ?? defaultMaxResultLength

  const tools = Object.values<Tool.Any>(presented.tools)
  // A tool whose approval depends on the call may need it, so code cannot call it.
  const needsApproval = (tool: Tool.Any) => tool.needsApproval !== undefined && tool.needsApproval !== false
  const direct = tools.filter(needsApproval)
  const callable = tools.filter((tool) => !needsApproval(tool))
  if (direct.some((tool) => tool.name === executeName)) {
    return yield* Effect.die(new Error(`A tool that needs approval is named ${executeName}`))
  }
  const callableNames = new Set(callable.map((tool) => tool.name))

  const Execute = Tool.make(executeName, {
    description: describeExecute(callable, direct.length > 0),
    parameters: Schema.Struct({
      code: Schema.String.annotate({ description: "The body of an async function" })
    }),
    success: Outcome,
    failure: ToolSource.Failure,
    // Code that fails is told so, and the model writes it again.
    failureMode: "return"
  })

  const callTool = (name: string, input: Schema.JsonObject) =>
    Presentation.hasTool(presented, name) && callableNames.has(name)
      ? Presentation.call(presented, name, input).pipe(Effect.provide(services))
      : Effect.fail(Presentation.failure("NotFoundError", `There is no tool named ${name}`))

  const run = (code: string) =>
    runtime.run({ code, tools: [...callableNames], call: callTool }).pipe(
      Effect.mapError(failureOfCodeError),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            Presentation.failure("Timeout", `The code ran longer than ${Duration.toMillis(timeout) / 1000} seconds`)
          )
      }),
      Effect.filterOrFail(
        (outcome) => JSON.stringify(outcome.result).length <= maxResultLength,
        (outcome) =>
          Presentation.failure(
            "ResultTooLarge",
            `The result is ${JSON.stringify(outcome.result).length} characters, more than the ` +
              `${maxResultLength} a run may return. Return only what you need of it.`
          )
      )
    )

  const ExecuteToolkit = Toolkit.make(Execute)
  const executeToolkit = yield* ExecuteToolkit.pipe(
    Effect.provide(ExecuteToolkit.toLayer({ [executeName]: ({ code }) => run(code) }))
  )
  return Presentation.merge(executeToolkit, Presentation.restrict(presented, new Set(direct.map((tool) => tool.name))))
})

/** What the model reads of `execute`: how to write the code, and the tools it can call. */
const describeExecute = (callable: ReadonlyArray<Tool.Any>, hasDirect: boolean) =>
  [
    "Runs JavaScript that calls tools. The code is the body of an async function: call a tool with " +
      "`await tools.<name>(input)`, note what you want to see with `console.log`, and `return` " +
      "what you want back, which must be JSON. A tool that fails throws an error with its message. " +
      "Do the filtering and combining of results in the code, so that only what you need comes back.",
    "The tools:",
    declare(
      callable.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Presentation.inputSchemaOf(tool)
      }))
    ),
    ...(hasDirect ? ["Tools that need a person's approval are not in `tools`: call them as tools of their own."] : [])
  ].join("\n\n")

/** What the model reads of code that failed: what it said, and what it logged before. */
const failureOfCodeError = (error: CodeError): ToolSource.Failure =>
  Presentation.failure(
    "CodeError",
    error.logs.length === 0
      ? error.description
      : `${error.description}\n\nLogged before it failed:\n${error.logs.join("\n")}`
  )
