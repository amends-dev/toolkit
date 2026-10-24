import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { TestClock } from "effect/testing"
import * as Assembly from "../../src/Assembly.ts"
import * as CodeMode from "../../src/CodeMode.ts"
import type { ToolDefinition } from "../../src/ToolDefinition.ts"
import type { ToolSource } from "../../src/ToolSource.ts"
import * as ToolSourceError from "../../src/ToolSourceError.ts"

const define = (name: string, description?: string): ToolDefinition => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false
  },
  annotations: {}
})

const issueTools = [
  define("list_issues", "Lists the issues of a repository"),
  define("create_issue", "Opens an issue"),
  define("delete_repository", "Deletes a repository for good"),
  define("get_user")
]

/** A source that answers each call with the tool and its input, and records what it was asked. */
const sourceOf = (
  answer: (tool: string, input: Schema.JsonObject) => ReturnType<ToolSource["call"]> = (tool, input) =>
    Effect.succeed({ ran: tool, input })
) => {
  const calls: Array<{ readonly tool: string; readonly input: Schema.JsonObject }> = []
  const source: ToolSource = {
    name: "github",
    discover: Effect.die("A toolkit does not ask the source what it has"),
    call: (tool, input) => {
      calls.push({ tool, input })
      return answer(tool, input)
    }
  }
  return { source, calls }
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parts: Array<string>
) => (...args: Array<unknown>) => Promise<unknown>

/**
 * A runtime for these tests, which runs the code in this process, so that it isolates nothing: it
 * gives the code `tools` and `console`, as a runtime does, and reads a throw as a failure.
 */
const inProcess: CodeMode.CodeRuntime = {
  run: ({ code, tools, call }) =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const run = Effect.runPromiseWith(yield* Effect.context<never>())
      const api = Object.fromEntries(
        tools.map((name) => [
          name,
          async (input: Schema.JsonObject = {}) => {
            const outcome = await run(
              Effect.match(call(name, input), {
                onFailure: (failure) => ({ failed: true as const, failure }),
                onSuccess: (value) => ({ failed: false as const, value })
              })
            )
            if (!outcome.failed) return outcome.value
            throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
          }
        ])
      )
      const log = { log: (...args: Array<unknown>) => logs.push(args.map(String).join(" ")) }
      const result = yield* Effect.tryPromise({
        try: () => new AsyncFunction("tools", "console", code)(api, log),
        catch: (error) =>
          new CodeMode.CodeError({
            description: error instanceof Error ? error.message : String(error),
            logs
          })
      })
      return { result: (result === undefined ? null : result) as Schema.Json, logs }
    })
}

/** The toolkit of a source with these tools, and of the code that calls them. */
const codeOver = (
  options: {
    readonly definitions?: ReadonlyArray<ToolDefinition>
    readonly source?: ToolSource
    readonly decide?: (source: string, definition: ToolDefinition) => Assembly.Decision
    readonly runtime?: CodeMode.CodeRuntime
    readonly codeOptions?: CodeMode.Options
  } = {}
) =>
  Effect.gen(function* () {
    const presented = yield* Assembly.toolkit(
      [
        {
          source: options.source ?? sourceOf().source,
          definitions: options.definitions ?? issueTools
        }
      ],
      options.decide ?? ((_source, definition) => (definition.name === "delete_repository" ? "approve" : "allow"))
    )
    return yield* CodeMode.toolkit(presented, options.runtime ?? inProcess, options.codeOptions)
  })

/** Has the model call a tool of the toolkit, as a harness does, and returns its last result. */
const call = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  name: string,
  params: unknown
) =>
  Effect.gen(function* () {
    const results = yield* toolkit.handle(name as keyof Tools, params as never).pipe(Effect.flatMap(Stream.runCollect))
    const last = results[results.length - 1]
    return { result: last?.result as unknown, isFailure: last?.isFailure }
  })

const execute = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.WithHandler<Tools>, code: string) =>
  call(toolkit, "execute", { code })

describe("CodeMode.toolkit", () => {
  it.effect("has execute, and the tools that need approval as tools of their own", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver()

      expect(Object.keys(toolkit.tools).sort()).toEqual(["execute", "github__delete_repository"])
    })
  )

  it.effect("keeps the approval of a tool that needs it, and runs the tool as it does", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* codeOver({ source: github.source })

      const { result, isFailure } = yield* call(toolkit, "github__delete_repository", {
        text: "old"
      })

      expect(toolkit.tools.github__delete_repository?.needsApproval).toBe(true)
      expect(toolkit.tools.execute?.needsApproval).toBeUndefined()
      expect(isFailure).toBe(false)
      expect(result).toEqual({ ran: "delete_repository", input: { text: "old" } })
    })
  )

  it.effect("refuses a call of a tool that code can call, which the model was not shown", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* codeOver({ source: github.source })

      const exit = yield* Effect.exit(call(toolkit, "github__list_issues", { text: "x" }))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(github.calls).toEqual([])
    })
  )

  it.effect("declares the tools that code can call in what the model reads of execute", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver()

      const description = Tool.getDescription(toolkit.tools.execute as Tool.Any) ?? ""

      expect(description).toContain("declare const tools: {")
      expect(description).toContain("/** Lists the issues of a repository */")
      expect(description).toContain("github__list_issues(input: {")
      expect(description).toContain("github__get_user(input: {")
      expect(description).toContain("await tools.<name>(input)")
      // The tool that needs approval is the model's to call, and no tool of the code's.
      expect(description).not.toContain("github__delete_repository(")
      expect(description).toContain("need a person's approval")
    })
  )

  it.effect("keeps a tool whose approval depends on the call as a tool of its own", () =>
    Effect.gen(function* () {
      const Pay = Tool.make("Pay", {
        parameters: Schema.Struct({ amount: Schema.Finite }),
        success: Schema.String,
        needsApproval: ({ amount }) => amount > 100
      })
      const Payments = Toolkit.make(Pay)
      const presented = yield* Payments.pipe(
        Effect.provide(Payments.toLayer({ Pay: ({ amount }) => Effect.succeed(`paid ${amount}`) }))
      )

      const toolkit = yield* CodeMode.toolkit(presented, inProcess)

      expect(Object.keys(toolkit.tools).sort()).toEqual(["Pay", "execute"])
      expect(typeof toolkit.tools.Pay?.needsApproval).toBe("function")
    })
  )

  it.effect("does not mention approval when no tool needs it", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({ decide: () => "allow" })

      expect(Object.keys(toolkit.tools)).toEqual(["execute"])
      expect(Tool.getDescription(toolkit.tools.execute as Tool.Any)).not.toContain("approval")
    })
  )

  it.effect("leaves out a tool the policy blocks, which the code cannot reach", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const seen: Array<ReadonlyArray<string>> = []
      const toolkit = yield* codeOver({
        source: github.source,
        decide: (_source, definition) => (definition.name === "get_user" ? "block" : "allow"),
        runtime: {
          run: (execution) =>
            Effect.sync(() => {
              seen.push(execution.tools)
              return { result: null, logs: [] }
            })
        }
      })

      yield* execute(toolkit, "return 1;")

      expect(Tool.getDescription(toolkit.tools.execute as Tool.Any)).not.toContain("get_user")
      expect(seen[0]).not.toContain("github__get_user")
      expect(github.calls).toEqual([])
    })
  )

  it.effect("contacts no source when it is made", () =>
    Effect.gen(function* () {
      const github = sourceOf()

      yield* codeOver({ source: github.source })

      expect(github.calls).toEqual([])
    })
  )

  it.effect("fails when a tool that needs approval has the name of execute", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(codeOver({ definitions: [define("execute")], decide: () => "approve" }))

      // The name the model knows it by is `github__execute`, so only another kind of toolkit clashes.
      expect(Exit.isSuccess(exit)).toBe(true)
      const Execute = Tool.make("execute", { success: Schema.String, needsApproval: true })
      const Clashing = Toolkit.make(Execute)
      const presented = yield* Clashing.pipe(
        Effect.provide(Clashing.toLayer({ execute: () => Effect.succeed("done") }))
      )

      const clash = yield* Effect.exit(CodeMode.toolkit(presented, inProcess))

      expect(Exit.isFailure(clash) && Cause.hasDies(clash.cause)).toBe(true)
    })
  )
})

describe("execute", () => {
  it.effect("runs the code, which calls a tool and returns what it gave", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* codeOver({ source: github.source })

      const { result, isFailure } = yield* execute(toolkit, 'return await tools.github__list_issues({ text: "open" });')

      expect(isFailure).toBe(false)
      expect(result).toEqual({
        result: { ran: "list_issues", input: { text: "open" } },
        logs: []
      })
      expect(github.calls).toEqual([{ tool: "list_issues", input: { text: "open" } }])
    })
  )

  it.effect("runs several calls and combines their results in the code", () =>
    Effect.gen(function* () {
      const github = sourceOf((tool, input) =>
        Effect.succeed({ tool, count: typeof input.text === "string" ? input.text.length : 0 })
      )
      const toolkit = yield* codeOver({ source: github.source })

      const { result } = yield* execute(
        toolkit,
        `const [first, second] = await Promise.all([
          tools.github__list_issues({ text: "abc" }),
          tools.github__create_issue({ text: "de" }),
        ]);
        return first.count + second.count;`
      )

      expect(result).toEqual({ result: 5, logs: [] })
      expect(github.calls.map((it) => it.tool).sort()).toEqual(["create_issue", "list_issues"])
    })
  )

  it.effect("gives back what the code logged, and null when it returns nothing", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver()

      const { result } = yield* execute(toolkit, 'console.log("one", 2); console.log("three");')

      expect(result).toEqual({ result: null, logs: ["one 2", "three"] })
    })
  )

  it.effect("tells the runtime the tools it may give the code, and nothing else", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = []
      const toolkit = yield* codeOver({
        runtime: {
          run: (execution) =>
            Effect.sync(() => {
              seen.push(execution.tools)
              return { result: null, logs: [] }
            })
        }
      })

      yield* execute(toolkit, "return 1;")

      expect(seen).toEqual([["github__list_issues", "github__create_issue", "github__get_user"]])
    })
  )

  it.effect("calls a tool with an empty input when the code gives none", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* codeOver({
        source: github.source,
        definitions: [{ name: "ping", inputSchema: { type: "object" }, annotations: {} }]
      })

      yield* execute(toolkit, "return await tools.github__ping();")

      expect(github.calls).toEqual([{ tool: "ping", input: {} }])
    })
  )

  it.effect("lets the code catch a failure of a tool, which it reads as an error", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({
        source: sourceOf(() =>
          Effect.fail(
            new ToolSourceError.ToolSourceError({
              source: "github",
              reason: new ToolSourceError.CallFailedError({ description: "No such repository" })
            })
          )
        ).source
      })

      const { result, isFailure } = yield* execute(
        toolkit,
        `try { await tools.github__list_issues({ text: "x" }); }
         catch (error) { return { message: error.message }; }`
      )

      expect(isFailure).toBe(false)
      expect(result).toEqual({
        result: { message: "CallFailedError: No such repository" },
        logs: []
      })
    })
  )

  it.effect("fails with what the code threw, and what it logged before", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({
        source: sourceOf(() =>
          Effect.fail(
            new ToolSourceError.ToolSourceError({
              source: "github",
              reason: new ToolSourceError.CallFailedError({ description: "No such repository" })
            })
          )
        ).source
      })

      const { result, isFailure } = yield* execute(
        toolkit,
        'console.log("about to call"); await tools.github__list_issues({ text: "x" });'
      )

      expect(isFailure).toBe(true)
      expect(result).toEqual({
        code: "CodeError",
        message: "CallFailedError: No such repository\n\nLogged before it failed:\nabout to call",
        retryable: false
      })
    })
  )

  it.effect("fails with the message of code that throws, or that is not code", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver()

      const thrown = yield* execute(toolkit, 'throw new Error("Boom");')
      const broken = yield* execute(toolkit, "return (;")

      expect(thrown).toEqual({
        result: { code: "CodeError", message: "Boom", retryable: false },
        isFailure: true
      })
      expect(broken.isFailure).toBe(true)
      expect(broken.result).toMatchObject({ code: "CodeError" })
    })
  )

  it.effect("fails a call of a tool the code may not call, and runs nothing", () =>
    Effect.gen(function* () {
      const github = sourceOf()

      // The runtime would not give the code these, but a runtime that did would reach the same end.
      const probe: CodeMode.CodeRuntime = {
        run: ({ call: callTool }) =>
          Effect.gen(function* () {
            const approval = yield* Effect.flip(callTool("github__delete_repository", { text: "x" }))
            const unknown = yield* Effect.flip(callTool("toString", {}))
            return { result: [approval.code, approval.message, unknown.code], logs: [] }
          }).pipe(Effect.orDie)
      }
      const probed = yield* codeOver({ source: github.source, runtime: probe })

      const { result } = yield* execute(probed, "")

      expect(result).toEqual({
        result: ["NotFoundError", "There is no tool named github__delete_repository", "NotFoundError"],
        logs: []
      })
      expect(github.calls).toEqual([])
    })
  )

  it.effect("fails a call of a tool with an input it does not take, as the tool does", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* codeOver({ source: github.source })

      const { result, isFailure } = yield* execute(toolkit, "return await tools.github__list_issues({ text: 4 });")

      expect(isFailure).toBe(true)
      expect(result).toMatchObject({ code: "CodeError" })
      expect(JSON.stringify(result)).toContain("Expected string")
      expect(github.calls).toEqual([])
    })
  )

  it.effect("fails with a failure that carries what the tool of a typed toolkit gave", () =>
    Effect.gen(function* () {
      const Add = Tool.make("Add", {
        description: "Adds two numbers",
        parameters: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
        success: Schema.Finite
      })
      const Pay = Tool.make("Pay", {
        parameters: Schema.Struct({ amount: Schema.Finite }),
        success: Schema.String,
        needsApproval: true
      })
      const MathToolkit = Toolkit.make(Add, Pay)
      const presented = yield* MathToolkit.pipe(
        Effect.provide(
          MathToolkit.toLayer({
            Add: ({ a, b }) => Effect.succeed(a + b),
            Pay: ({ amount }) => Effect.succeed(`paid ${amount}`)
          })
        )
      )
      const toolkit = yield* CodeMode.toolkit(presented, inProcess)

      const sum = yield* call(toolkit, "execute", {
        code: "return await tools.Add({ a: 2, b: 3 });"
      })
      const paid = yield* call(toolkit, "Pay", { amount: 5 })
      const bad = yield* call(toolkit, "execute", {
        code: 'return await tools.Add({ a: "two", b: 3 });'
      })

      expect(Object.keys(toolkit.tools).sort()).toEqual(["Pay", "execute"])
      expect(sum.result).toEqual({ result: 5, logs: [] })
      expect(paid.result).toBe("paid 5")
      expect(bad.isFailure).toBe(true)
    })
  )
})

describe("limits", () => {
  it.effect("fails code that runs longer than the timeout, a minute by default", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({
        runtime: { run: () => Effect.never }
      })
      const running = yield* Effect.forkChild(execute(toolkit, "while (true) {}"))
      yield* Effect.yieldNow

      yield* TestClock.adjust("59 seconds")
      const early = running.pollUnsafe()
      yield* TestClock.adjust("1 second")
      const { result, isFailure } = yield* Fiber.join(running)

      expect(early).toBeUndefined()
      expect(isFailure).toBe(true)
      expect(result).toEqual({
        code: "Timeout",
        message: "The code ran longer than 60 seconds",
        retryable: false
      })
    })
  )

  it.effect("counts the time its tools take in the timeout, and takes the timeout it is given", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({
        source: sourceOf(() => Effect.never).source,
        codeOptions: { timeout: "5 seconds" }
      })
      const running = yield* Effect.forkChild(
        execute(toolkit, 'return await tools.github__list_issues({ text: "x" });')
      )
      yield* Effect.yieldNow

      yield* TestClock.adjust("5 seconds")
      const { result } = yield* Fiber.join(running)

      expect(result).toMatchObject({
        code: "Timeout",
        message: "The code ran longer than 5 seconds"
      })
    })
  )

  it.effect("returns a result as long as the limit, and fails with one longer", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver({ codeOptions: { maxResultLength: 12 } })

      // The JSON of a string has its quotes: ten characters of text are twelve.
      const fits = yield* execute(toolkit, 'return "x".repeat(10);')
      const tooLong = yield* execute(toolkit, 'return "x".repeat(11);')

      expect(fits.isFailure).toBe(false)
      expect(tooLong.isFailure).toBe(true)
      expect(tooLong.result).toEqual({
        code: "ResultTooLarge",
        message: "The result is 13 characters, more than the 12 a run may return. Return only what you need of it.",
        retryable: false
      })
    })
  )

  it.effect("allows a result of fifty thousand characters by default", () =>
    Effect.gen(function* () {
      const toolkit = yield* codeOver()

      const fits = yield* execute(toolkit, 'return "x".repeat(49998);')
      const tooLong = yield* execute(toolkit, 'return "x".repeat(49999);')

      expect(fits.isFailure).toBe(false)
      expect(tooLong.result).toMatchObject({ code: "ResultTooLarge" })
    })
  )

  it.effect("ends the run when the call is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const toolkit = yield* codeOver({
        runtime: {
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
            )
        }
      })
      const running = yield* Effect.forkChild(execute(toolkit, "await new Promise(() => {});"))
      yield* Deferred.await(started)

      yield* Fiber.interrupt(running)

      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      yield* Deferred.await(interrupted)
    })
  )
})
