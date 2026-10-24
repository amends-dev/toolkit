import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ToolSourceError from "../src/ToolSourceError.ts"

const failWith = (reason: ToolSourceError.ToolSourceErrorReason) =>
  new ToolSourceError.ToolSourceError({ source: "github", reason })

describe("ToolSourceError", () => {
  it("names the source and gives a reason's description, or its default message without one", () => {
    const described = failWith(new ToolSourceError.CallFailedError({ description: "Issue 7 is locked" }))
    const bare = failWith(new ToolSourceError.CallFailedError({}))

    expect(described.message).toBe("github: Issue 7 is locked")
    expect(bare.message).toBe("github: The tool reported a failure")
  })

  it("can be tried again only when the source is unavailable", () => {
    const retryable = [
      new ToolSourceError.UnavailableError({}),
      new ToolSourceError.AuthenticationError({}),
      new ToolSourceError.NotFoundError({}),
      new ToolSourceError.InvalidInputError({}),
      new ToolSourceError.CallFailedError({}),
      new ToolSourceError.InvalidResponseError({}),
      new ToolSourceError.UnsupportedError({}),
      new ToolSourceError.UnknownError({})
    ].map((reason) => [reason._tag, failWith(reason).isRetryable])

    expect(retryable).toEqual([
      ["UnavailableError", true],
      ["AuthenticationError", false],
      ["NotFoundError", false],
      ["InvalidInputError", false],
      ["CallFailedError", false],
      ["InvalidResponseError", false],
      ["UnsupportedError", false],
      ["UnknownError", false]
    ])
  })

  it("tells the model what a failure it can act on says, and nothing of the rest", () => {
    const address = "connect ECONNREFUSED 10.0.3.7:8443"

    const read = (reason: ToolSourceError.ToolSourceErrorReason) => reason.modelMessage

    expect(read(new ToolSourceError.InvalidInputError({ description: "`title` is required" }))).toBe(
      "`title` is required"
    )
    expect(read(new ToolSourceError.CallFailedError({ description: "Issue 7 is locked" }))).toBe("Issue 7 is locked")
    // The description of any other reason may name internals, so the model reads the default.
    expect(read(new ToolSourceError.UnavailableError({ description: address }))).toBe(
      "The source is temporarily unavailable"
    )
    expect(read(new ToolSourceError.UnknownError({ description: address }))).toBe("The source failed")
    expect(read(new ToolSourceError.InvalidInputError({}))).toBe("The input does not match the tool's parameters")
  })

  it.effect("recovers from one reason and leaves the others", () =>
    Effect.gen(function* () {
      const askAgain = (reason: ToolSourceError.ToolSourceErrorReason) =>
        Effect.fail(failWith(reason)).pipe(
          Effect.catchReason("ToolSourceError", "AuthenticationError", () => Effect.succeed("connect again"))
        )

      expect(yield* askAgain(new ToolSourceError.AuthenticationError({}))).toBe("connect again")
      const other = yield* Effect.flip(askAgain(new ToolSourceError.UnavailableError({})))
      expect(other.reason._tag).toBe("UnavailableError")
    })
  )

  it.effect("keeps its reason through JSON, so it can cross a wire", () =>
    Effect.gen(function* () {
      const json = Schema.toCodecJson(ToolSourceError.ToolSourceError)
      const error = failWith(new ToolSourceError.CallFailedError({ description: "Locked" }))

      const stored = JSON.stringify(yield* Schema.encodeEffect(json)(error))
      const decoded = yield* Schema.decodeUnknownEffect(json)(JSON.parse(stored))

      expect(decoded.source).toBe("github")
      expect(decoded.reason).toBeInstanceOf(ToolSourceError.CallFailedError)
      expect(decoded.reason.message).toBe("Locked")
      expect(decoded.isRetryable).toBe(false)
    })
  )
})
