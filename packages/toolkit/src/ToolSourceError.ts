/**
 * Errors a tool source reports when it cannot do what it was asked: tell which tools it has, or run
 * one. A tool that ran and reported its own failure is one of them, as `CallFailedError`.
 *
 * `ToolSourceError` says which source failed and holds the reason, so callers can recover from one
 * reason with `Effect.catchReason("ToolSourceError", "AuthenticationError", ...)`, as a host does
 * to ask for a connection again. The operation that failed is the one the caller ran, which its
 * span names.
 *
 * Each reason has a `description`, what happened in the words of whoever reports it, and says with
 * `isRetryable` whether trying again may succeed. `modelMessage` is what a model reads of it. The
 * descriptions of `InvalidInputError` and `CallFailedError` are written for it, to say what to
 * correct and what the tool said. The description of any other reason may name an address or
 * another internal, so the model reads only its default message.
 *
 * @since 0.1.0
 */

import type * as HttpClientError from "effect/http/HttpClientError"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/**
 * The source's credentials are missing, invalid, or not allowed to do this.
 *
 * @category errors
 * @since 0.1.0
 */
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>(
  "@amends-dev/toolkit/ToolSourceError/AuthenticationError"
)("AuthenticationError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The credentials for this tool are missing, invalid, or not authorized"
  }
}

/**
 * The source has no tool of the name it was asked to run, such as one it has removed since.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>(
  "@amends-dev/toolkit/ToolSourceError/NotFoundError"
)("NotFoundError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The source has no tool of this name"
  }
}

/**
 * The input does not match the tool's parameters. Its description says what to correct.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>(
  "@amends-dev/toolkit/ToolSourceError/InvalidInputError"
)("InvalidInputError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The input does not match the tool's parameters"
  }

  get modelMessage(): string {
    return this.message
  }
}

/**
 * The tool ran and reported that it failed. Its description is what the tool said.
 *
 * @category errors
 * @since 0.1.0
 */
export class CallFailedError extends Schema.TaggedError<CallFailedError>(
  "@amends-dev/toolkit/ToolSourceError/CallFailedError"
)("CallFailedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The tool reported a failure"
  }

  get modelMessage(): string {
    return this.message
  }
}

/**
 * The source cannot answer now: it said that it is down or busy, or it could not be reached. The
 * only reason worth trying again.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnavailableError extends Schema.TaggedError<UnavailableError>(
  "@amends-dev/toolkit/ToolSourceError/UnavailableError"
)("UnavailableError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The source is temporarily unavailable"
  }
}

/**
 * The source answered in a way its protocol does not allow, such as a result that is not JSON.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidResponseError extends Schema.TaggedError<InvalidResponseError>(
  "@amends-dev/toolkit/ToolSourceError/InvalidResponseError"
)("InvalidResponseError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The source answered in a way its protocol does not allow"
  }
}

/**
 * The source does not do what was asked, such as running a tool that asks for input first,
 * returning an answer of a media type a tool cannot return, or speaking the server's protocol.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>(
  "@amends-dev/toolkit/ToolSourceError/UnsupportedError"
)("UnsupportedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The source does not support this operation"
  }
}

/**
 * The source failed in a way no other reason names, such as a defect in its code or a request
 * that could not be sent. The model reads only that the source failed.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnknownError extends Schema.TaggedError<UnknownError>("@amends-dev/toolkit/ToolSourceError/UnknownError")(
  "UnknownError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? this.modelMessage
  }

  get modelMessage(): string {
    return "The source failed"
  }
}

/**
 * Why a tool source failed: one of the errors above, which `ToolSourceError.reason` holds.
 *
 * @category errors
 * @since 0.1.0
 */
export const ToolSourceErrorReason = Schema.Union([
  AuthenticationError,
  NotFoundError,
  InvalidInputError,
  CallFailedError,
  UnavailableError,
  InvalidResponseError,
  UnsupportedError,
  UnknownError
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * @category errors
 * @since 0.1.0
 */
export type ToolSourceErrorReason = typeof ToolSourceErrorReason.Type

/**
 * Why a request that got no answer failed: a server that could not be reached is unavailable, and
 * anything else about the request is unknown.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reasonFromHttpClientError = (error: HttpClientError.HttpClientError): ToolSourceErrorReason =>
  Predicate.isTagged(error.reason, "TransportError")
    ? new UnavailableError({})
    : new UnknownError({ description: error.message })

/**
 * What every operation of a tool source fails with: the source that failed, by its name, and the
 * reason. Only an `UnavailableError` is worth trying again, as `isRetryable` says.
 *
 * **Example** (Recovering from one reason)
 *
 * ```ts
 * import type { ToolSource } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 *
 * declare const github: ToolSource.ToolSource
 * declare const askToConnectAgain: Effect.Effect<void>
 *
 * // A refused credential is the connection's to fix; the other reasons stay failures.
 * const definitions = github.discover.pipe(
 *   Effect.catchReason("ToolSourceError", "AuthenticationError", () => Effect.as(askToConnectAgain, []))
 * )
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class ToolSourceError extends Schema.TaggedError<ToolSourceError>("@amends-dev/toolkit/ToolSourceError")(
  "ToolSourceError",
  {
    /** The source that failed, as its name gives it, such as `github`. */
    source: Schema.String,

    /** Why the source failed. */
    reason: ToolSourceErrorReason,

    /** The failure underneath, such as an HTTP client's error, which the model never reads. */
    cause: Schema.optional(Schema.Defect())
  }
) {
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }

  override get message(): string {
    return `${this.source}: ${this.reason.message}`
  }
}
