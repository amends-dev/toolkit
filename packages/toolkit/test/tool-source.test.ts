import { describe, expect, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { Tool } from "effect/ai"
import type { ToolDefinition } from "../src/ToolDefinition.ts"
import * as ToolSource from "../src/ToolSource.ts"
import * as ToolSourceError from "../src/ToolSourceError.ts"

const createIssue: ToolDefinition = {
  name: "create_issue",
  description: "Creates an issue",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      priority: { enum: ["low", "high"] },
      points: { type: "integer" }
    },
    required: ["title"],
    additionalProperties: false
  },
  annotations: { title: "Create issue", destructive: false, idempotent: false }
}

const ping: ToolDefinition = {
  name: "ping",
  inputSchema: { type: "object" },
  annotations: {}
}

/** A source that answers each call with `answer` and records what it was asked. */
const fakeSource = (
  answer: (tool: string, input: Schema.JsonObject) => ReturnType<ToolSource.ToolSource["call"]> = (tool) =>
    Effect.succeed({ ran: tool })
) => {
  const calls: Array<{ readonly tool: string; readonly input: Schema.JsonObject }> = []
  const source: ToolSource.ToolSource = {
    name: "github",
    discover: Effect.die("A toolkit does not ask the source what it has"),
    call: (tool, input) => {
      calls.push({ tool, input })
      return answer(tool, input)
    }
  }
  return { source, calls }
}

/** Builds the toolkit and has the model call one of its tools, as a harness does. */
const callTool = (
  source: ToolSource.ToolSource,
  definitions: ReadonlyArray<ToolDefinition>,
  name: string,
  params: unknown
) =>
  Effect.gen(function* () {
    const toolkit = yield* ToolSource.toolkit(source, definitions)
    const results = yield* toolkit.handle(name, params).pipe(Effect.flatMap(Stream.runCollect))
    const last = results[results.length - 1]
    return { result: last?.result, isFailure: last?.isFailure }
  })

describe("ToolSource.toolkit", () => {
  it.effect("asks a model API not to use its strict schema mode, which the source's parameters may not fit", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const toolkit = yield* ToolSource.toolkit(source, [createIssue, ping])

      expect(Tool.getStrictMode(toolkit.tools["create_issue"]!)).toBe(false)
      expect(Tool.getStrictMode(toolkit.tools["ping"]!)).toBe(false)
    })
  )

  it.effect("builds a tool for each definition, with its parameters and the hints it gave", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const toolkit = yield* ToolSource.toolkit(source, [createIssue, ping])

      expect(Object.keys(toolkit.tools)).toEqual(["create_issue", "ping"])
      const tool = toolkit.tools["create_issue"]
      expect(tool?.description).toBe("Creates an issue")
      expect(Tool.getJsonSchema(tool!)).toEqual(createIssue.inputSchema)
      expect(Context.getOption(tool!.annotations, Tool.Title)).toEqual(Option.some("Create issue"))
      expect(Context.get(tool!.annotations, Tool.Destructive)).toBe(false)
      expect(Context.get(tool!.annotations, Tool.Idempotent)).toBe(false)
    })
  )

  it.effect("leaves a hint the source did not give at Effect AI's default", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const toolkit = yield* ToolSource.toolkit(source, [ping])

      const annotations = toolkit.tools["ping"]!.annotations
      expect(Context.get(annotations, Tool.Readonly)).toBe(false)
      expect(Context.get(annotations, Tool.Destructive)).toBe(true)
      expect(Context.get(annotations, Tool.Idempotent)).toBe(false)
      expect(Context.get(annotations, Tool.OpenWorld)).toBe(true)
    })
  )

  it.effect("runs the source's tool of the definition's name with the model's input", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource((tool) => Effect.succeed({ id: 7, tool }))

      const outcome = yield* callTool(source, [createIssue, ping], "create_issue", {
        title: "Broken build",
        priority: "high"
      })

      expect(outcome).toEqual({ result: { id: 7, tool: "create_issue" }, isFailure: false })
      expect(calls).toEqual([{ tool: "create_issue", input: { title: "Broken build", priority: "high" } }])
    })
  )

  it.effect("asks the source nothing when it builds, and never what it has", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()

      yield* ToolSource.toolkit(source, [createIssue])

      // The fake's `discover` is a defect, so building would have failed if it had asked.
      expect(calls).toEqual([])
    })
  )

  it.effect("refuses two definitions of one name", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const exit = yield* Effect.exit(ToolSource.toolkit(source, [ping, ping]))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    })
  )
})

describe("the tools a model must ask about", () => {
  it.effect("are marked as needing approval, and the others are not", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const toolkit = yield* ToolSource.toolkit(source, [createIssue, ping], {
        needsApproval: (definition) => definition.name === "create_issue"
      })

      expect(toolkit.tools["create_issue"]?.needsApproval).toBe(true)
      expect(toolkit.tools["ping"]?.needsApproval).toBeUndefined()
    })
  )

  it.effect("are none unless the caller names some", () =>
    Effect.gen(function* () {
      const { source } = fakeSource()

      const toolkit = yield* ToolSource.toolkit(source, [createIssue])

      expect(toolkit.tools["create_issue"]?.needsApproval).toBeUndefined()
    })
  )

  it.effect("still run when called, as the session has asked before it does", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()
      const toolkit = yield* ToolSource.toolkit(source, [createIssue], {
        needsApproval: () => true
      })

      yield* toolkit.handle("create_issue", { title: "Broken build" }).pipe(Effect.flatMap(Stream.runCollect))

      expect(calls).toEqual([{ tool: "create_issue", input: { title: "Broken build" } }])
    })
  )
})

describe("a tool call's input", () => {
  const reads = (outcome: { readonly result: unknown }) => outcome.result as ToolSource.Failure

  it.effect("is read by the model as a failure when it does not match, and never reaches the source", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()

      const outcome = yield* callTool(source, [createIssue], "create_issue", { title: 7 })

      expect(outcome.isFailure).toBe(true)
      expect(reads(outcome).code).toBe("InvalidInputError")
      expect(reads(outcome).retryable).toBe(false)
      expect(reads(outcome).message).toContain("title")
      expect(reads(outcome).message).not.toContain("\n")
      expect(calls).toEqual([])
    })
  )

  it.effect("is refused when it lacks what is required, or is not an object", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()

      const missing = yield* callTool(source, [createIssue], "create_issue", {})
      const text = yield* callTool(source, [createIssue], "create_issue", "Broken build")

      expect(reads(missing).code).toBe("InvalidInputError")
      expect(reads(text).code).toBe("InvalidInputError")
      expect(calls).toEqual([])
    })
  )

  it.effect("is held to the parameters' enums and integers", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()

      const unknownPriority = yield* callTool(source, [createIssue], "create_issue", {
        title: "x",
        priority: "urgent"
      })
      const fraction = yield* callTool(source, [createIssue], "create_issue", {
        title: "x",
        points: 1.5
      })

      expect(reads(unknownPriority).code).toBe("InvalidInputError")
      expect(reads(fraction).code).toBe("InvalidInputError")
      expect(calls).toEqual([])
    })
  )

  it.effect("is refused for a property a closed object does not name", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()

      const outcome = yield* callTool(source, [createIssue], "create_issue", {
        title: "x",
        assignee: "sarib"
      })

      expect(reads(outcome).code).toBe("InvalidInputError")
      expect(calls).toEqual([])
    })
  )

  it.effect("keeps the properties an open object does not name, as the model gave them", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()
      const input = { query: "is:open", labels: ["bug"], nested: { depth: 2 } }

      yield* callTool(source, [ping], "ping", input)

      expect(calls).toEqual([{ tool: "ping", input }])
    })
  )

  it.effect("follows a reference into the schema's definitions", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()
      const referencing: ToolDefinition = {
        name: "label",
        inputSchema: {
          type: "object",
          properties: { name: { $ref: "#/$defs/name" } },
          required: ["name"],
          $defs: { name: { type: "string", minLength: 1 } }
        },
        annotations: {}
      }

      const wrong = yield* callTool(source, [referencing], "label", { name: 3 })
      const right = yield* callTool(source, [referencing], "label", { name: "bug" })

      expect(reads(wrong).code).toBe("InvalidInputError")
      expect(right.isFailure).toBe(false)
      expect(calls).toEqual([{ tool: "label", input: { name: "bug" } }])
    })
  )

  it.effect("is left to the source to check beyond the object, when the parameters cannot be checked here", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()
      // `contains` is a keyword Effect AI cannot turn into a check.
      const unsupported: ToolDefinition = {
        name: "tag",
        inputSchema: {
          type: "object",
          properties: { tags: { type: "array", contains: { const: "bug" } } }
        },
        annotations: {}
      }

      const outcome = yield* callTool(source, [unsupported], "tag", { tags: ["bug"] })
      const notAnObject = yield* callTool(source, [unsupported], "tag", [1])

      expect(outcome.isFailure).toBe(false)
      expect(calls).toEqual([{ tool: "tag", input: { tags: ["bug"] } }])
      expect(reads(notAnObject).code).toBe("InvalidInputError")
    })
  )

  it.effect("is not held to a pattern, which is the source's to run", () =>
    Effect.gen(function* () {
      const { source, calls } = fakeSource()
      const patterned: ToolDefinition = {
        name: "find",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", pattern: "^(a+)+$" } }
        },
        annotations: {}
      }

      const outcome = yield* callTool(source, [patterned], "find", { query: "b" })

      expect(outcome.isFailure).toBe(false)
      expect(calls).toHaveLength(1)
    })
  )
})

describe("a tool call that fails", () => {
  const failing = (reason: ToolSourceError.ToolSourceErrorReason) =>
    fakeSource(() => Effect.fail(new ToolSourceError.ToolSourceError({ source: "github", reason })))

  it.effect("is read by the model as a failure with the reason, what it may read, and whether to retry", () =>
    Effect.gen(function* () {
      const { source } = failing(new ToolSourceError.CallFailedError({ description: "Issue 7 is locked" }))
      const unavailable = failing(new ToolSourceError.UnavailableError({}))

      const failed = yield* callTool(source, [ping], "ping", {})
      const retry = yield* callTool(unavailable.source, [ping], "ping", {})

      expect(failed).toEqual({
        result: { code: "CallFailedError", message: "Issue 7 is locked", retryable: false },
        isFailure: true
      })
      expect(retry).toEqual({
        result: {
          code: "UnavailableError",
          message: "The source is temporarily unavailable",
          retryable: true
        },
        isFailure: true
      })
    })
  )

  it.effect("keeps what only the source should know from the model", () =>
    Effect.gen(function* () {
      const address = "connect ECONNREFUSED 10.0.3.7:8443"
      const { source } = failing(new ToolSourceError.UnavailableError({ description: address }))

      const outcome = yield* callTool(source, [ping], "ping", {})

      expect(JSON.stringify(outcome.result)).not.toContain("10.0.3.7")
    })
  )

  it.effect("is read by the model as the source failing, when the source has a defect", () =>
    Effect.gen(function* () {
      const { source } = fakeSource(() => Effect.die(new Error("null at 10.0.3.7")))

      const outcome = yield* callTool(source, [ping], "ping", {})

      expect(outcome).toEqual({
        result: { code: "UnknownError", message: "The source failed", retryable: false },
        isFailure: true
      })
    })
  )

  it.effect("ends with the call when the call is interrupted, and tells the model nothing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { source } = fakeSource(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))

      const fiber = yield* Effect.forkChild(callTool(source, [ping], "ping", {}))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })
  )
})

describe("ToolSource.Failure", () => {
  it.effect("is JSON, so a result carries it across a wire", () =>
    Effect.gen(function* () {
      const failure: ToolSource.Failure = {
        code: "UnavailableError",
        message: "The source is temporarily unavailable",
        retryable: true
      }
      const json = Schema.toCodecJson(ToolSource.Failure)

      const stored = JSON.stringify(yield* Schema.encodeEffect(json)(failure))

      expect(yield* Schema.decodeUnknownEffect(json)(JSON.parse(stored))).toEqual(failure)
    })
  )
})
