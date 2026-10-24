import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as ToolDefinition from "../../ToolDefinition.ts"
import type * as Fixture from "../Fixture.ts"

/** What a source says of the tools it has. */
export const discovery = <E>(fixture: Fixture.Fixture<E>) =>
  describe("tool discovery", () => {
    const { echo, failing, blocking } = fixture.tools

    it.live(
      "lists definitions that a catalog can store as JSON",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")
          const json = Schema.toCodecJson(Schema.Array(ToolDefinition.ToolDefinition))

          const definitions = yield* source.discover
          const stored = JSON.stringify(yield* Schema.encodeEffect(json)(definitions))

          expect(yield* Schema.decodeUnknownEffect(json)(JSON.parse(stored))).toEqual(definitions)
        }),
      fixture.timeout
    )

    it.live(
      "lists the tools of the fixture, each by a name of its own",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")

          const names = (yield* source.discover).map((definition) => definition.name)

          expect(names).toEqual(expect.arrayContaining([echo.tool, failing.tool, blocking.tool]))
          expect(new Set(names).size).toBe(names.length)
        }),
      fixture.timeout
    )

    it.live(
      "lists the same tools each time it is asked, when nothing has changed",
      () =>
        Effect.gen(function* () {
          const { source } = yield* fixture.make("working")

          const first = yield* source.discover
          const second = yield* source.discover

          expect(second).toEqual(first)
        }),
      fixture.timeout
    )
  })
