/**
 * The test suites every kind of tool source runs against itself, so that code written against
 * `ToolSource` works the same on each: what a source lists, how its calls run, what it reports of a
 * system that cannot be used, and what a model reads of it through the toolkit and an assembly. A
 * source's tests call `run` with a `Fixture`, which makes the source over a system that serves the
 * tools the suites call. They need `@effect/vitest`, an optional peer dependency of this package,
 * which only a source's tests install.
 *
 * The suites run on the live clock, as a source over a network takes real time. Each test makes a
 * source of its own, so that no test depends on another.
 *
 * @since 0.1.0
 */

import type * as Fixture from "./Fixture.ts"
import { calls } from "./internal/calls.ts"
import { conditions } from "./internal/conditions.ts"
import { discovery } from "./internal/discovery.ts"
import { toolkit } from "./internal/toolkit.ts"

export type {
  /**
   * How the system behind the source is for a test, re-exported so that a source's tests need only
   * this module.
   *
   * @category testing
   * @since 0.1.0
   */
  Condition,
  /**
   * What a source's tests give the suites, re-exported so that they need only this module.
   *
   * @category testing
   * @since 0.1.0
   */
  Fixture,
  /**
   * The source under test and what the suites need of its system, re-exported so that a source's
   * tests need only this module.
   *
   * @category testing
   * @since 0.1.0
   */
  Subject,
  /**
   * A tool of the fixture and the input that calls it, re-exported so that a source's tests need
   * only this module.
   *
   * @category testing
   * @since 0.1.0
   */
  ToolCase
} from "./Fixture.ts"

/**
 * Runs every suite against the source `fixture` makes, in the test file that calls it.
 *
 * **Example** (The conformance test of the MCP source)
 *
 * ```ts
 * import { Mcp } from "@amends-dev/toolkit"
 * import * as Conformance from "@amends-dev/toolkit/conformance"
 * import { Effect, Scope } from "effect"
 * import { HttpClient } from "effect/http"
 *
 * // Serves `echo`, `failing`, and `blocking` over MCP in `condition`, until the scope closes.
 * declare const serveMcp: (condition: Conformance.Condition) => Effect.Effect<
 *   {
 *     readonly client: HttpClient.HttpClient
 *     readonly started: Effect.Effect<void>
 *     readonly secrets: ReadonlyArray<string>
 *   },
 *   never,
 *   Scope.Scope
 * >
 *
 * Conformance.run({
 *   make: Effect.fnUntraced(function* (condition) {
 *     const { client, started, secrets } = yield* serveMcp(condition)
 *     const source = yield* Mcp.http({ name: "fixture", url: "http://localhost/mcp", client })
 *     return { source, blockedCallStarted: started, secrets }
 *   }),
 *   tools: {
 *     echo: { tool: "echo", input: (text) => ({ text }), invalidInput: { text: 7 } },
 *     failing: { tool: "failing", input: {} },
 *     blocking: { tool: "blocking", input: {} }
 *   }
 * })
 * ```
 *
 * @category testing
 * @since 0.1.0
 */
export const run = <E>(fixture: Fixture.Fixture<E>) => {
  discovery(fixture)
  calls(fixture)
  conditions(fixture)
  toolkit(fixture)
}
