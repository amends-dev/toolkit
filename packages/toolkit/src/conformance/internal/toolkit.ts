import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Assembly from "../../Assembly.ts"
import * as ToolSource from "../../ToolSource.ts"
import type * as Fixture from "../Fixture.ts"

/** What a model reads of a source, through the toolkit that is made of it. */
export const toolkit = <E>(fixture: Fixture.Fixture<E>) =>
  describe("the toolkit of a source", () => {
    const { echo, failing } = fixture.tools

    /**
     * Has the model call a tool of the source, as a harness does, and returns the last result. The
     * toolkit is made of definitions that a catalog stored while the system worked, and the call
     * is made over the system in `condition`.
     */
    const callTool = (condition: Fixture.Condition, name: string, input: unknown) =>
      Effect.gen(function* () {
        const stored = yield* (yield* fixture.make("working")).source.discover
        const { source } = yield* fixture.make(condition)
        const toolkit = yield* ToolSource.toolkit(source, stored)
        const results = yield* toolkit.handle(name, input).pipe(Effect.flatMap(Stream.runCollect))
        const last = results[results.length - 1]
        return { result: last?.result, isFailure: last?.isFailure }
      })

    it.live(
      "has a tool for each tool the source lists, by its name",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          const definitions = yield* source.discover

          const toolkit = yield* ToolSource.toolkit(source, definitions)

          expect(Object.keys(toolkit.tools).sort()).toEqual(definitions.map((definition) => definition.name).sort())
        }),
      fixture.timeout
    )

    it.live(
      "answers a call as a result",
      () =>
        Effect.gen(function* () {
          const outcome = yield* callTool("working", echo.tool, echo.input("hello model"))

          expect(outcome.isFailure).toBe(false)
          expect(JSON.stringify(outcome.result)).toContain("hello model")
        }),
      fixture.timeout
    )

    it.live(
      "answers a call that failed as a result the model reads, with what the tool said",
      () =>
        Effect.gen(function* () {
          const outcome = yield* callTool("working", failing.tool, failing.input)

          expect(outcome.isFailure).toBe(true)
          expect(outcome.result).toMatchObject({ code: "CallFailedError", retryable: false })
        }),
      fixture.timeout
    )

    it.live(
      "answers a call to a system that cannot be used as a result, with whether to try again",
      () =>
        Effect.gen(function* () {
          const refused = yield* callTool("unauthorized", echo.tool, echo.input("x"))
          const down = yield* callTool("unavailable", echo.tool, echo.input("x"))
          const gone = yield* callTool("unreachable", echo.tool, echo.input("x"))

          expect(refused.result).toMatchObject({ code: "AuthenticationError", retryable: false })
          expect(down.result).toMatchObject({ code: "UnavailableError", retryable: true })
          expect(gone.result).toMatchObject({ code: "UnavailableError", retryable: true })
          expect([refused, down, gone].every((outcome) => outcome.isFailure === true)).toBe(true)
        }),
      fixture.timeout
    )

    it.live(
      "refuses an input that the tool's parameters do not allow",
      () =>
        Effect.gen(function* () {
          const outcome = yield* callTool("working", echo.tool, echo.invalidInput)

          expect(outcome.isFailure).toBe(true)
          expect(outcome.result).toMatchObject({ code: "InvalidInputError" })
        }),
      fixture.timeout
    )

    it.live(
      "can be assembled with the tools of other sources, and is called by the name that gives",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          const definitions = yield* source.discover

          const assembled = yield* Assembly.toolkit([{ source, definitions }], () => "allow")
          const name = `${source.name}__${echo.tool}`.replace(/[^A-Za-z0-9_-]/g, "_")
          const results = yield* assembled
            .handle(name, echo.input("through the assembly"))
            .pipe(Effect.flatMap(Stream.runCollect))
          const last = results[results.length - 1]

          expect(Object.keys(assembled.tools)).toHaveLength(definitions.length)
          expect(last?.isFailure).toBe(false)
          expect(JSON.stringify(last?.result)).toContain("through the assembly")
        }),
      fixture.timeout
    )
  })
