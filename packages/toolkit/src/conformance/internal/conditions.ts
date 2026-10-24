import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as ToolSourceError from "../../ToolSourceError.ts"
import type * as Fixture from "../Fixture.ts"

/** What a source reports of a system it cannot use, which is all the model reads of it. */
export const conditions = <E>(fixture: Fixture.Fixture<E>) =>
  describe("a system that cannot be used", () => {
    const { echo, failing } = fixture.tools

    const failedCall = (condition: Fixture.Condition) =>
      Effect.gen(function* () {
        const { source, secrets } = yield* fixture.make(condition)
        const error = yield* Effect.flip(source.call(echo.tool, echo.input("hello")))
        return { error, source, secrets }
      })

    it.live(
      "refuses the source, when the credentials it has are not accepted, which is not tried again",
      () =>
        Effect.gen(function* () {
          const { error, source } = yield* failedCall("unauthorized")

          expect(error).toBeInstanceOf(ToolSourceError.ToolSourceError)
          expect(error.source).toBe(source.name)
          expect(error.reason._tag).toBe("AuthenticationError")
          expect(error.isRetryable).toBe(false)
        }),
      fixture.timeout
    )

    it.live(
      "is unavailable when it says that it is down, which may be tried again",
      () =>
        Effect.gen(function* () {
          const { error } = yield* failedCall("unavailable")

          expect(error.reason._tag).toBe("UnavailableError")
          expect(error.isRetryable).toBe(true)
        }),
      fixture.timeout
    )

    it.live(
      "is unavailable when it cannot be reached, which may be tried again",
      () =>
        Effect.gen(function* () {
          const { error } = yield* failedCall("unreachable")

          expect(error.reason._tag).toBe("UnavailableError")
          expect(error.isRetryable).toBe(true)
        }),
      fixture.timeout
    )

    it.live(
      "fails a request for what it has, when it asks the system, as the same reason",
      () =>
        Effect.gen(function* () {
          const reasons: Array<readonly [Fixture.Condition, string | undefined]> = []
          for (const condition of ["unauthorized", "unavailable", "unreachable"] as const) {
            const { source } = yield* fixture.make(condition)
            // A source may know what it has without asking, and then it has nothing to report.
            const exit = yield* Effect.exit(source.discover)
            if (Exit.isSuccess(exit)) continue
            const error = Cause.squash(exit.cause)
            expect(error).toBeInstanceOf(ToolSourceError.ToolSourceError)
            reasons.push([condition, (error as ToolSourceError.ToolSourceError).reason._tag])
          }

          for (const [condition, reason] of reasons) {
            expect(reason).toBe(condition === "unauthorized" ? "AuthenticationError" : "UnavailableError")
          }
        }),
      fixture.timeout
    )

    it.live(
      "does not tell a model a credential or an address, whatever failed",
      () =>
        Effect.gen(function* () {
          const read: Array<string> = []
          for (const condition of ["unauthorized", "unavailable", "unreachable"] as const) {
            const { error, secrets } = yield* failedCall(condition)
            expect(secrets.length).toBeGreaterThan(0)
            read.push(error.reason.modelMessage)
            for (const secret of secrets) expect(error.reason.modelMessage).not.toContain(secret)
          }
          const { source, secrets } = yield* fixture.make("working")
          const reported = yield* Effect.flip(source.call(failing.tool, failing.input))
          for (const secret of secrets) expect(reported.reason.modelMessage).not.toContain(secret)

          expect(read.every((message) => message !== "")).toBe(true)
        }),
      fixture.timeout
    )
  })
