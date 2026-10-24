import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import * as Presentation from "../src/Presentation.ts"

const Add = Tool.make("Add", {
  description: "Adds two numbers",
  parameters: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  success: Schema.Finite
})
const Greet = Tool.make("Greet", {
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String
})
const Fail = Tool.make("Fail", { success: Schema.String, failure: Schema.String })
const NoResult = Tool.make("Quiet", { success: Schema.Void })

const MathToolkit = Toolkit.make(Add, Greet, Fail, NoResult)
const math = MathToolkit.pipe(
  Effect.provide(
    MathToolkit.toLayer({
      Add: ({ a, b }) => Effect.succeed(a + b),
      Greet: ({ name }) => Effect.succeed(`hello ${name}`),
      Fail: () => Effect.fail("It always does"),
      Quiet: () => Effect.void
    })
  )
)

/** Has the toolkit run the tool the way a harness does, and returns the results it streams. */
const run = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  name: string,
  params: unknown
) => toolkit.handle(name as keyof Tools, params as never).pipe(Effect.flatMap(Stream.runCollect))

describe("Presentation.hasTool", () => {
  it.effect("is true for the tools a toolkit has, and not for a name it inherits", () =>
    Effect.gen(function* () {
      const presented = yield* math

      expect(Presentation.hasTool(presented, "Add")).toBe(true)
      expect(Presentation.hasTool(presented, "Subtract")).toBe(false)
      expect(Presentation.hasTool(presented, "toString")).toBe(false)
      expect(Presentation.hasTool(presented, "__proto__")).toBe(false)
    })
  )
})

describe("Presentation.call", () => {
  it.effect("runs the tool and gives its result as JSON", () =>
    Effect.gen(function* () {
      const presented = yield* math

      expect(yield* Presentation.call(presented, "Add", { a: 2, b: 3 })).toBe(5)
    })
  )

  it.effect("fails with the failure of a tool, as its text, and of its parameters", () =>
    Effect.gen(function* () {
      const presented = yield* math

      const failed = yield* Effect.flip(Presentation.call(presented, "Fail", {}))
      const refused = yield* Effect.flip(Presentation.call(presented, "Add", { a: "two", b: 3 }))

      expect(failed).toEqual({ code: "CallFailed", message: "It always does", retryable: false })
      expect(refused).toMatchObject({ code: "CallFailed", retryable: false })
      expect(refused.message).toContain("Add")
    })
  )

  it.effect("gives null for a tool that gave nothing", () =>
    Effect.gen(function* () {
      const presented = yield* math

      expect(yield* Presentation.call(presented, "Quiet", {})).toBe(null)
    })
  )
})

describe("Presentation.inputSchemaOf", () => {
  it("gives the JSON Schema of a tool's parameters", () => {
    expect(Presentation.inputSchemaOf(Add)).toMatchObject({
      type: "object",
      required: ["a", "b"]
    })
  })

  it("gives an object for a tool without parameters", () => {
    expect(Presentation.inputSchemaOf(Fail)).toMatchObject({ type: "object" })
  })
})

describe("Presentation.restrict", () => {
  it.effect("has only the tools it is given the names of, which run as they do", () =>
    Effect.gen(function* () {
      const restricted = Presentation.restrict(yield* math, new Set(["Add", "Greet"]))

      const results = yield* run(restricted, "Add", { a: 1, b: 2 })

      expect(Object.keys(restricted.tools)).toEqual(["Add", "Greet"])
      expect(results[results.length - 1]?.result).toBe(3)
    })
  )

  it.effect("fails a call of a tool it does not have, though the toolkit has it", () =>
    Effect.gen(function* () {
      const restricted = Presentation.restrict(yield* math, new Set(["Add"]))

      const exit = yield* Effect.exit(run(restricted, "Greet", { name: "Ada" }))

      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})

describe("Presentation.merge", () => {
  it.effect("has the tools of both, each run by the toolkit that has it", () =>
    Effect.gen(function* () {
      const presented = yield* math
      const merged = Presentation.merge(
        Presentation.restrict(presented, new Set(["Add"])),
        Presentation.restrict(presented, new Set(["Greet"]))
      )

      const sum = yield* run(merged, "Add", { a: 1, b: 2 })
      const greeting = yield* run(merged, "Greet", { name: "Ada" })

      expect(Object.keys(merged.tools).sort()).toEqual(["Add", "Greet"])
      expect(sum[sum.length - 1]?.result).toBe(3)
      expect(greeting[greeting.length - 1]?.result).toBe("hello Ada")
    })
  )

  it.effect("gives a name that both have to the first", () =>
    Effect.gen(function* () {
      const presented = yield* math
      const other = yield* Effect.gen(function* () {
        const Also = Toolkit.make(Tool.make("Add", { success: Schema.String }))
        return yield* Also.pipe(Effect.provide(Also.toLayer({ Add: () => Effect.succeed("other") })))
      })
      const merged = Presentation.merge(other, Presentation.restrict(presented, new Set(["Add"])))

      const results = yield* run(merged, "Add", {})

      expect(results[results.length - 1]?.result).toBe("other")
    })
  )

  it.effect("fails a call of a tool neither has", () =>
    Effect.gen(function* () {
      const presented = yield* math
      const merged = Presentation.merge(
        Presentation.restrict(presented, new Set(["Add"])),
        Presentation.restrict(presented, new Set(["Greet"]))
      )

      const error = yield* Effect.flip(run(merged, "Fail", {}))

      // It names the tools of both toolkits as the tools it has.
      expect(error).toMatchObject({
        reason: { _tag: "ToolNotFoundError", toolName: "Fail", availableTools: ["Greet", "Add"] }
      })
    })
  )
})
