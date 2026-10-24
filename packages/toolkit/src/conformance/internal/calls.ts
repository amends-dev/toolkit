import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as ToolSourceError from "../../ToolSourceError.ts"
import type * as Fixture from "../Fixture.ts"

/** Running tools. */
export const calls = <E>(fixture: Fixture.Fixture<E>) =>
  describe("tool calls", () => {
    const { echo, failing, blocking } = fixture.tools

    it.live(
      "runs a tool by the name it was discovered under, and returns JSON that has what the tool answered",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          const discovered = (yield* source.discover).map((definition) => definition.name)

          const answer = yield* source.call(echo.tool, echo.input("hello there"))

          expect(discovered).toContain(echo.tool)
          expect(Schema.is(Schema.Json)(answer)).toBe(true)
          expect(JSON.stringify(answer)).toContain("hello there")
        }),
      fixture.timeout
    )

    it.live(
      "answers each of many calls that run together with the answer to it",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          const texts = Array.from({ length: 8 }, (_, index) => `text-${index}-of-eight`)

          const answers = yield* Effect.forEach(texts, (text) => source.call(echo.tool, echo.input(text)), {
            concurrency: "unbounded"
          })

          answers.forEach((answer, index) => {
            const said = JSON.stringify(answer)
            texts.forEach((text, other) => expect(said.includes(text)).toBe(index === other))
          })
        }),
      fixture.timeout
    )

    it.live(
      "fails a tool that reports its failure, with what it said",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")

          const error = yield* Effect.flip(source.call(failing.tool, failing.input))

          expect(error).toBeInstanceOf(ToolSourceError.ToolSourceError)
          expect(error.source).toBe(source.name)
          expect(error.reason._tag).toBe("CallFailedError")
          expect(error.reason.message).not.toBe("")
        }),
      fixture.timeout
    )

    it.live(
      "fails a call for a tool it does not have, as an error of the source and not a defect",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")

          const error = yield* Effect.flip(source.call("a-tool-no-source-has", {}))

          expect(error).toBeInstanceOf(ToolSourceError.ToolSourceError)
          expect(error.source).toBe(source.name)
        }),
      fixture.timeout
    )

    it.live(
      "runs tools again after a call failed",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          yield* Effect.flip(source.call(failing.tool, failing.input))
          yield* Effect.flip(source.call("a-tool-no-source-has", {}))

          const answer = yield* source.call(echo.tool, echo.input("still here"))

          expect(JSON.stringify(answer)).toContain("still here")
        }),
      fixture.timeout
    )

    it.live(
      "stops a call that is interrupted, and runs tools after it",
      () =>
        Effect.gen(function* () {
          const { source, blockedCallStarted } = yield* fixture.make("working")

          const fiber = yield* Effect.forkChild(source.call(blocking.tool, blocking.input))
          yield* blockedCallStarted
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          const answer = yield* source.call(echo.tool, echo.input("after the interruption"))

          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(JSON.stringify(answer)).toContain("after the interruption")
        }),
      fixture.timeout
    )
  })
