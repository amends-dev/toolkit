import { CodeMode, ToolSource } from "@amends-dev/toolkit"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import * as OpencodeCodeRuntime from "../src/OpencodeCodeRuntime.ts"

/** Runs `code` with `echo`, which answers with its input, and `failing`, which fails as a source's tool does. */
const run = (code: string, options?: OpencodeCodeRuntime.Options) =>
  OpencodeCodeRuntime.make(options).run({
    code,
    tools: ["echo", "failing"],
    call: (tool, input) =>
      tool === "echo"
        ? Effect.succeed(input)
        : Effect.fail({ code: "CallFailedError", message: "No such repository", retryable: false })
  })

describe("OpencodeCodeRuntime", () => {
  it.effect("gives back what the code returns, as JSON, and null for nothing", () =>
    Effect.gen(function* () {
      const returned = yield* run(`return { issues: [1, 2].map((n) => ({ n })) }`)
      const expression = yield* run(`1 + 1`)
      const nothing = yield* run(`const unused = 1`)

      expect(returned.result).toEqual({ issues: [{ n: 1 }, { n: 2 }] })
      expect(expression.result).toBe(2)
      expect(nothing.result).toBeNull()
    })
  )

  it.effect("calls a tool with the object the code gives, and gives the code the tool's answer", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        `const answers = await Promise.all([tools.echo({ text: "a" }), tools.echo({ text: "b" })])
         return answers.map((answer) => answer.text).join("")`
      )

      expect(result).toBe("ab")
    })
  )

  it.effect("gives the code a tool's failure as an error whose message names the reason and what happened", () =>
    Effect.gen(function* () {
      const { result } = yield* run(`try { await tools.failing({}) } catch (error) { return error.message }`)

      expect(result).toBe("CallFailedError: No such repository")
    })
  )

  it.effect("keeps what the code logged, with the warnings of what it left running", () =>
    Effect.gen(function* () {
      const { result, logs } = yield* run(`console.log("seen", 1); tools.echo({ text: "unawaited" }); return 2`)

      expect(result).toBe(2)
      expect(logs[0]).toBe("seen 1")
    })
  )

  it.effect("fails with what the code threw, and keeps what it logged before", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(`console.log("before"); throw new Error("boom")`))

      expect(error.description).toContain("ExecutionFailure")
      expect(error.description).toContain("boom")
      expect(error.logs).toEqual(["before"])
    })
  )

  it.effect("fails code it cannot parse, saying where", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(`return (`))

      expect(error.description).toContain("ParseError")
      expect(error.description).toContain("1:8")
    })
  )

  it.effect("fails a call of a tool the run does not have, naming it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(`return await tools.other({})`))

      expect(error.description).toContain("other")
    })
  )

  it.effect("gives the code nothing but its tools", () =>
    Effect.gen(function* () {
      const { result } = yield* run(`return [typeof fetch, typeof process, typeof require, typeof tools.echo]`)

      expect(result).toEqual(["undefined", "undefined", "undefined", "function"])
    })
  )

  it.effect("stops a run that calls more tools than allowed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(`for (let i = 0; i < 3; i++) await tools.echo({ i }); return "done"`, { maxToolCalls: 2 })
      )

      expect(error.description).toContain("ToolCallLimitExceeded")
    })
  )

  it.live("ends a run that is interrupted, as a timeout interrupts it", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(run(`let n = 0; while (true) { n++ }`))
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })
  )

  it.effect("runs the code a model gives `execute`, as CodeMode.toolkit presents it", () =>
    Effect.gen(function* () {
      const source: ToolSource.ToolSource = {
        name: "github",
        discover: Effect.die("not asked"),
        call: (_tool, input) => Effect.succeed({ issues: [{ title: `about ${(input as { text: string }).text}` }] })
      }
      const definitions = [
        {
          name: "list_issues",
          inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] },
          annotations: {}
        }
      ]
      const presented = yield* ToolSource.toolkit(source, definitions)
      const toolkit = yield* CodeMode.toolkit(presented, OpencodeCodeRuntime.make())

      const results = yield* toolkit
        .handle("execute", {
          code: `const { issues } = await tools.list_issues({ text: "sandboxes" }); return issues.map((issue) => issue.title)`
        })
        .pipe(Effect.flatMap(Stream.runCollect))
      const last = results[results.length - 1]

      expect(last?.isFailure).toBe(false)
      expect(last?.result).toEqual({ result: ["about sandboxes"], logs: [] })
    })
  )
})
