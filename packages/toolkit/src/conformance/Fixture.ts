/**
 * What a tool source gives the conformance suites. The suites need a system to run the tools of: an
 * MCP server, an HTTP API, whatever the source reaches. The fixture serves three tools of it, which
 * every source is tested with, and makes the source for one test over a system in the condition the
 * suite asks for.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as ToolSource from "../ToolSource.ts"

/**
 * How the system the source reaches is for a test: it works, it refuses the credentials the source
 * has, it answers that it is down, or it cannot be reached.
 *
 * @category testing
 * @since 0.1.0
 */
export type Condition = "working" | "unauthorized" | "unavailable" | "unreachable"

/**
 * The source under test, for one test, with what the suites need of the system behind it.
 *
 * @category testing
 * @since 0.1.0
 */
export interface Subject {
  readonly source: ToolSource.ToolSource

  /** Completes once the system has been asked to run the blocking tool. */
  readonly blockedCallStarted: Effect.Effect<void>

  /**
   * What the source holds that must not reach a model, which is credentials, and the address of the
   * system if it could say something of what is inside.
   */
  readonly secrets: ReadonlyArray<string>
}

/**
 * A tool of the fixture, and the input that calls it.
 *
 * @category testing
 * @since 0.1.0
 */
export interface ToolCase {
  /** The name the source discovers the tool under, short enough to stay as it is in an assembly. */
  readonly tool: string

  /** An input that the tool's parameters allow. */
  readonly input: Schema.JsonObject
}

/**
 * What a source's tests give `run`: how to make the source over a system in each condition, and
 * the three tools of that system the suites call, `echo`, `failing`, and `blocking`.
 *
 * @category testing
 * @since 0.1.0
 */
export interface Fixture<E> {
  /**
   * Makes the source for one test, over a system in `condition`. What it starts ends with the
   * scope of the test.
   */
  readonly make: (condition: Condition) => Effect.Effect<Subject, E, Scope.Scope>

  /** The system's tools that the suites call, each by the name the source discovers it under. */
  readonly tools: {
    /** Answers with the text it is given, which is somewhere in what the source returns. */
    readonly echo: {
      readonly tool: string

      /** The input that asks the tool to answer with `text`. */
      readonly input: (text: string) => Schema.JsonObject

      /** An input that the tool's parameters do not allow. */
      readonly invalidInput: Schema.JsonObject
    }

    /** Reports that it failed, whatever its input. */
    readonly failing: ToolCase

    /** Does not answer, until the call that asked it is given up. */
    readonly blocking: ToolCase
  }

  /** How many milliseconds a test may take, more than the default for a source on the network. */
  readonly timeout?: number
}
