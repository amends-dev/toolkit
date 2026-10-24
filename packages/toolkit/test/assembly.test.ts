import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { Tool } from "effect/ai"
import * as Assembly from "../src/Assembly.ts"
import type { ToolDefinition } from "../src/ToolDefinition.ts"
import type { ToolSource } from "../src/ToolSource.ts"
import * as ToolSourceError from "../src/ToolSourceError.ts"

const define = (name: string, overrides?: Partial<ToolDefinition>): ToolDefinition => ({
  name,
  description: `Does ${name}`,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: {},
  ...overrides
})

/** A source that answers each call with the tool it ran, and records what it was asked. */
const sourceOf = (
  name: string,
  answer: (tool: string) => ReturnType<ToolSource["call"]> = (tool) => Effect.succeed({ ran: tool, by: name })
) => {
  const calls: Array<{ readonly tool: string; readonly input: Schema.JsonObject }> = []
  const source: ToolSource = {
    name,
    discover: Effect.die("An assembly does not ask a source what it has"),
    call: (tool, input) => {
      calls.push({ tool, input })
      return answer(tool)
    }
  }
  return { source, calls }
}

const allowAll = () => "allow" as const

/** Builds the toolkit and has the model call one of its tools, as a harness does. */
const callTool = (
  members: ReadonlyArray<Assembly.Member>,
  name: string,
  params: unknown,
  decide: (source: string, definition: ToolDefinition) => Assembly.Decision = allowAll
) =>
  Effect.gen(function* () {
    const toolkit = yield* Assembly.toolkit(members, decide)
    const results = yield* toolkit.handle(name, params).pipe(Effect.flatMap(Stream.runCollect))
    const last = results[results.length - 1]
    return { result: last?.result, isFailure: last?.isFailure }
  })

describe("Assembly.toolkit", () => {
  it.effect("names each tool by its source and its own name, in the order the members give", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")
      const notes = sourceOf("notes")

      const toolkit = yield* Assembly.toolkit(
        [
          { source: github.source, definitions: [define("create_issue"), define("search")] },
          { source: notes.source, definitions: [define("search")] }
        ],
        allowAll
      )

      expect(Object.keys(toolkit.tools)).toEqual(["github__create_issue", "github__search", "notes__search"])
    })
  )

  it.effect("gives a tool what its source gave it, under the new name", () =>
    Effect.gen(function* () {
      const { source } = sourceOf("github")
      const definition = define("create_issue", {
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        },
        annotations: { title: "Create issue", readOnly: false }
      })

      const toolkit = yield* Assembly.toolkit([{ source, definitions: [definition] }], allowAll)

      const tool = toolkit.tools["github__create_issue"]!
      expect(tool.name).toBe("github__create_issue")
      expect(tool.description).toBe("Does create_issue")
      expect(Tool.getJsonSchema(tool)).toEqual(definition.inputSchema)
    })
  )

  it.effect("runs a call by the source's name for the tool, and by no other source", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")
      const notes = sourceOf("notes")
      const members = [
        { source: github.source, definitions: [define("search")] },
        { source: notes.source, definitions: [define("search")] }
      ]

      const outcome = yield* callTool(members, "notes__search", { text: "plans" })

      expect(outcome).toEqual({ result: { ran: "search", by: "notes" }, isFailure: false })
      expect(notes.calls).toEqual([{ tool: "search", input: { text: "plans" } }])
      expect(github.calls).toEqual([])
    })
  )

  it.effect("tells the model what a source's failure says, as a tool does", () =>
    Effect.gen(function* () {
      const locked = sourceOf("github", () =>
        Effect.fail(
          new ToolSourceError.ToolSourceError({
            source: "github",
            reason: new ToolSourceError.CallFailedError({ description: "Issue 7 is locked" })
          })
        )
      )

      const outcome = yield* callTool([{ source: locked.source, definitions: [define("lock")] }], "github__lock", {})

      expect(outcome).toEqual({
        result: { code: "CallFailedError", message: "Issue 7 is locked", retryable: false },
        isFailure: true
      })
    })
  )

  it.effect("leaves out the tools that are blocked, and asks the source nothing of them", () =>
    Effect.gen(function* () {
      const { source } = sourceOf("github")

      const toolkit = yield* Assembly.toolkit(
        [{ source, definitions: [define("search"), define("delete_repo")] }],
        (_, definition) => (definition.name === "delete_repo" ? "block" : "allow")
      )

      expect(Object.keys(toolkit.tools)).toEqual(["github__search"])
    })
  )

  it.effect("marks the tools that are to be approved, and runs them once they are", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")
      const members = [{ source: github.source, definitions: [define("search"), define("create_issue")] }]
      const decide = (_: string, definition: ToolDefinition) =>
        definition.name === "create_issue" ? ("approve" as const) : ("allow" as const)

      const toolkit = yield* Assembly.toolkit(members, decide)
      const outcome = yield* callTool(members, "github__create_issue", {}, decide)

      expect(toolkit.tools["github__search"]?.needsApproval).toBeUndefined()
      expect(toolkit.tools["github__create_issue"]?.needsApproval).toBe(true)
      expect(outcome.isFailure).toBe(false)
      expect(github.calls).toEqual([{ tool: "create_issue", input: {} }])
    })
  )

  it.effect("asks for the decision on each tool once, with its source's name and its definition", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")
      const notes = sourceOf("notes")
      const asked: Array<readonly [string, string]> = []

      yield* Assembly.toolkit(
        [
          { source: github.source, definitions: [define("search"), define("create_issue")] },
          { source: notes.source, definitions: [define("search")] }
        ],
        (source, definition) => {
          asked.push([source, definition.name])
          return "allow"
        }
      )

      expect(asked).toEqual([
        ["github", "search"],
        ["github", "create_issue"],
        ["notes", "search"]
      ])
    })
  )

  it.effect("contacts none of the sources", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")

      yield* Assembly.toolkit([{ source: github.source, definitions: [define("search")] }], allowAll)

      // The fake's `discover` is a defect, so building would have failed if it had asked.
      expect(github.calls).toEqual([])
    })
  )

  it.effect("is a toolkit with no tools when there is nothing to give", () =>
    Effect.gen(function* () {
      const none = yield* Assembly.toolkit([], allowAll)
      const github = sourceOf("github")
      const blocked = yield* Assembly.toolkit(
        [{ source: github.source, definitions: [define("search")] }],
        () => "block"
      )

      expect(Object.keys(none.tools)).toEqual([])
      expect(Object.keys(blocked.tools)).toEqual([])
    })
  )
})

describe("the name of a tool", () => {
  const namesOf = (source: string, tools: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const toolkit = yield* Assembly.toolkit(
        [{ source: sourceOf(source).source, definitions: tools.map((tool) => define(tool)) }],
        allowAll
      )
      return Object.keys(toolkit.tools)
    })

  it.effect("has only the characters an agent accepts, and the call still reaches the tool", () =>
    Effect.gen(function* () {
      const github = sourceOf("my github")

      const outcome = yield* callTool(
        [{ source: github.source, definitions: [define("repos/list.all")] }],
        "my_github__repos_list_all",
        {}
      )

      expect(yield* namesOf("my github", ["repos/list.all", "café"])).toEqual([
        "my_github__repos_list_all",
        "my_github__caf_"
      ])
      expect(outcome.isFailure).toBe(false)
      expect(github.calls).toEqual([{ tool: "repos/list.all", input: {} }])
    })
  )

  it.effect("is no longer than the model APIs allow, and ends with a fingerprint when it is cut", () =>
    Effect.gen(function* () {
      const [name, short] = yield* namesOf("github", ["a".repeat(120), "b"])

      expect(name).toHaveLength(64)
      expect(name).toMatch(/^github__a+_[0-9a-f]{8}$/)
      expect(short).toBe("github__b")
    })
  )

  it.effect("is no longer than an agent takes, when the agent takes fewer characters", () =>
    Effect.gen(function* () {
      const toolkit = yield* Assembly.toolkit(
        [
          {
            source: sourceOf("github").source,
            definitions: [define("a".repeat(120)), define("short"), define("b".repeat(40))]
          }
        ],
        allowAll,
        { maxNameLength: 59 }
      )

      const [cut, short, fits] = Object.keys(toolkit.tools)

      expect(cut).toHaveLength(59)
      expect(cut).toMatch(/^github__a+_[0-9a-f]{8}$/)
      expect(short).toBe("github__short")
      // Fits as it is.
      expect(fits).toBe(`github__${"b".repeat(40)}`)
    })
  )

  it.effect("is cut only as the agent's limit asks, and the call still reaches the tool", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")
      const tool = "a".repeat(70)
      const toolkit = yield* Assembly.toolkit([{ source: github.source, definitions: [define(tool)] }], allowAll, {
        maxNameLength: 20
      })
      const [name = ""] = Object.keys(toolkit.tools)

      yield* toolkit.handle(name, {}).pipe(Effect.flatMap(Stream.runCollect))

      expect(name).toHaveLength(20)
      expect(github.calls).toEqual([{ tool, input: {} }])
    })
  )

  it.effect.each([0, 15, 20.5, Number.NaN])(
    "refuses a limit of %s, which is not a whole number of at least 16",
    (limit) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Assembly.toolkit([], allowAll, { maxNameLength: limit }))

        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
          "maxNameLength must be a whole number of at least 16"
        )
      })
  )

  it.effect("is not cut to the same name for tools that differ only after the cut", () =>
    Effect.gen(function* () {
      const long = "repos/get-the-billing-premium-request-usage-report-for-"

      const names = yield* namesOf("github", [`${long}organization`, `${long}user`])

      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
      expect(names.every((name) => name.length === 64)).toBe(true)
    })
  )

  it.effect("is the same whenever it is made", () =>
    Effect.gen(function* () {
      const tool = `repos/${"x".repeat(100)}`

      const first = yield* namesOf("github", [tool])
      const again = yield* namesOf("github", [tool])

      expect(again).toEqual(first)
      // Pinned, as a name is stored in what the model said, so how it is made must not change.
      expect(first).toEqual(["github__repos_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_bf0dac0e"])
    })
  )

  it.effect("has a fingerprint of eight digits, which has leading zeros when the number has", () =>
    Effect.gen(function* () {
      const names = yield* namesOf("github", [
        "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
      ])

      expect(names).toEqual(["github__yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_0561d867"])
    })
  )

  it.effect("is cut with the fingerprint of the name as it was, so tools whose characters differ stay apart", () =>
    Effect.gen(function* () {
      const [dotted, underscored] = yield* namesOf("github", [`${"a".repeat(80)}.b`, `${"a".repeat(80)}_b`])

      expect(dotted).not.toBe(underscored)
    })
  )
})

describe("tools that would have one name", () => {
  const clashOf = (members: ReadonlyArray<Assembly.Member>, decide = allowAll) =>
    Effect.flip(Assembly.toolkit(members, decide))

  it.effect("fail the assembly, with each of the tools told by its source", () =>
    Effect.gen(function* () {
      // Both are named `a_b__c`, as the characters an agent accepts leave them.
      const first = sourceOf("a.b")
      const second = sourceOf("a_b")

      const error = yield* clashOf([
        { source: first.source, definitions: [define("c")] },
        { source: second.source, definitions: [define("c")] }
      ])

      expect(error).toBeInstanceOf(Assembly.NameClash)
      expect(error.clashes).toEqual([
        {
          name: "a_b__c",
          tools: [
            { source: "a.b", tool: "c" },
            { source: "a_b", tool: "c" }
          ]
        }
      ])
      expect(error.message).toBe("a.b: c and a_b: c are all named a_b__c")
    })
  )

  it.effect("fail the assembly when one source has two tools of a name", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")

      const error = yield* clashOf([{ source: github.source, definitions: [define("search"), define("search")] }])

      expect(error.clashes.map((clash) => clash.name)).toEqual(["github__search"])
    })
  )

  it.effect("are all told at once, in the order they were met", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")

      const error = yield* clashOf([
        {
          source: github.source,
          definitions: [define("a.b"), define("c"), define("a_b"), define("c")]
        }
      ])

      expect(error.clashes.map((clash) => clash.name)).toEqual(["github__a_b", "github__c"])
    })
  )

  it.effect("do not fail the assembly when only one of them is given to the model", () =>
    Effect.gen(function* () {
      const github = sourceOf("github")

      const toolkit = yield* Assembly.toolkit(
        [{ source: github.source, definitions: [define("a.b"), define("a_b")] }],
        (_, definition) => (definition.name === "a.b" ? "block" : "allow")
      )

      expect(Object.keys(toolkit.tools)).toEqual(["github__a_b"])
    })
  )
})

describe("Assembly.Decision", () => {
  it.effect("is JSON, so a policy can be stored", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Assembly.Decision)

      expect(yield* decode("approve")).toBe("approve")
      expect(Schema.isSchemaError(yield* Effect.flip(decode("maybe")))).toBe(true)
    })
  )
})
