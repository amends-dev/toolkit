/**
 * opencode's code mode as the runtime of `@amends-dev/toolkit`'s code mode. `@opencode/codemode`
 * interprets the code a model writes, a subset of JavaScript that it implements itself, so the
 * code can reach nothing it does not implement: no engine, worker, or serialization stands between
 * the code and the tools, and what the code is given is only `tools`, `console`, and `search`. `make`
 * gives the `CodeRuntime` that `CodeMode.toolkit` takes.
 *
 * @since 0.1.0
 */

import { CodeMode } from "@amends-dev/toolkit"
import * as Codemode from "@opencode/codemode"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/**
 * What `make` takes.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /**
   * The most calls of tools one run may make, which the calls of `search`, the function the
   * interpreter gives the code to find tools by, count in. Unlimited by default.
   */
  readonly maxToolCalls?: number
}

/**
 * Makes the runtime. A run interprets the code with the tools of its execution as `tools`, each
 * called as `await tools.<name>(input)`, and gives back what the code returned, as JSON, with what
 * it logged. A failure of a tool reaches the code as an error whose message names the reason and
 * what happened. A run that does not finish fails with `CodeError`: what the code threw, code the
 * interpreter does not run, a call of a tool the run does not have, or more calls than allowed,
 * each with where in the code when the interpreter knows.
 *
 * **Example** (Code mode over opencode's interpreter)
 *
 * ```ts
 * import { OpencodeCodeRuntime } from "@amends-dev/codemode-opencode"
 * import { Assembly, CodeMode } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 *
 * declare const members: ReadonlyArray<Assembly.Member>
 *
 * const program = Effect.gen(function* () {
 *   const assembled = yield* Assembly.toolkit(members, () => "allow")
 *   // The model is shown `execute`, whose code calls the assembled tools on this runtime.
 *   return yield* CodeMode.toolkit(assembled, OpencodeCodeRuntime.make({ maxToolCalls: 50 }))
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options = {}): CodeMode.CodeRuntime => ({
  run: ({ code, tools, call }) => {
    const runtime = Codemode.CodeMode.make({
      tools: Object.fromEntries(tools.map((name) => [name, toolOf(name, call)])),
      limits: options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }
    })
    return Effect.flatMap(runtime.execute(code), outcomeOf)
  }
})

/** The tool `name` of the execution as the interpreter calls it: an object in, JSON out. */
const toolOf = (name: string, call: CodeMode.Execution["call"]) =>
  Codemode.Tool.make({
    // What the model reads of the tools is `execute`'s own description, so the interpreter's
    // `search` tells the code only their names.
    description: "",
    // The execution checks the input against the tool's parameters; the interpreter checks nothing,
    // so what the code gave arrives as it is, an object or not.
    input: { type: "object" },
    output: {},
    execute: (input) =>
      call(name, input as Schema.JsonObject).pipe(
        // The code reads a failure as an error whose message names the reason and what happened.
        Effect.mapError((failure) => Codemode.toolError(`${failure.code}: ${failure.message}`))
      )
  })

/** What a run gave back, as the interpreter reports it: the value and the logs, or why it did not finish. */
const outcomeOf = (result: Codemode.CodeMode.Result): Effect.Effect<CodeMode.Outcome, CodeMode.CodeError> => {
  const logs = result.logs ?? []
  if (!result.ok) return Effect.fail(new CodeMode.CodeError({ description: describe(result.error), logs }))
  // A rejection the code did not await, and work it left running when it returned, are warnings,
  // which the model reads after the logs.
  const warnings = (result.warnings ?? []).map((warning) => `Warning: ${warning.message}`)
  return Effect.succeed({ result: result.value, logs: [...logs, ...warnings] })
}

/** A diagnostic on one line: its kind, where in the code, what happened, and what to do about it. */
const describe = ({ kind, message, location, suggestions }: Codemode.CodeMode.Diagnostic) =>
  [
    location === undefined
      ? `${kind}: ${message}`
      : `${kind} at line ${location.line}, column ${location.column}: ${message}`,
    ...(suggestions ?? [])
  ].join(" ")
