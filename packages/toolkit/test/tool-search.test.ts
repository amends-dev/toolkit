import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import * as Assembly from "../src/Assembly.ts"
import type { ToolDefinition } from "../src/ToolDefinition.ts"
import * as ToolSearch from "../src/ToolSearch.ts"
import type { ToolSource } from "../src/ToolSource.ts"
import * as ToolSourceError from "../src/ToolSourceError.ts"

const define = (name: string, description?: string, overrides?: Partial<ToolDefinition>): ToolDefinition => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: {},
  ...overrides
})

/** A source that answers each call with the tool it ran and its input, and records what it was asked. */
const sourceOf = (
  answer: (tool: string, input: Schema.JsonObject) => ReturnType<ToolSource["call"]> = (tool, input) =>
    Effect.succeed({ ran: tool, input })
) => {
  const calls: Array<{ readonly tool: string; readonly input: Schema.JsonObject }> = []
  const source: ToolSource = {
    name: "github",
    discover: Effect.die("A toolkit does not ask the source what it has"),
    call: (tool, input) => {
      calls.push({ tool, input })
      return answer(tool, input)
    }
  }
  return { source, calls }
}

const issueTools = [
  define("create_issue", "Opens an issue in a repository"),
  define("list_issues", "Lists the issues of a repository"),
  define("close_issue", "Closes an issue"),
  define("search_code", "Finds code in a repository by what it says"),
  define("create_pull_request", "Opens a pull request that asks for a review of an issue's fix"),
  define("get_user")
]

/** The toolkit of a source with these tools, over which the search is made. */
const searchOver = (
  definitions: ReadonlyArray<ToolDefinition> = issueTools,
  source: ToolSource = sourceOf().source,
  decide: (source: string, definition: ToolDefinition) => Assembly.Decision = () => "allow",
  options?: ToolSearch.Options
) =>
  Effect.gen(function* () {
    const presented = yield* Assembly.toolkit([{ source, definitions }], decide)
    return yield* ToolSearch.toolkit(presented, options)
  })

/** Has the model call a tool of the search toolkit, as a harness does, and returns its last result. */
const call = (
  toolkit: Effect.Success<ReturnType<typeof searchOver>>,
  name: "tool_search" | "tool_call",
  params: unknown
) =>
  Effect.gen(function* () {
    const results = yield* toolkit.handle(name, params as never).pipe(Effect.flatMap(Stream.runCollect))
    const last = results[results.length - 1]
    return { result: last?.result as unknown, isFailure: last?.isFailure }
  })

const search = (toolkit: Effect.Success<ReturnType<typeof searchOver>>, query: string, limit?: number) =>
  call(toolkit, "tool_search", limit === undefined ? { query } : { query, limit })

/** The names of the tools a search returned, in order. */
const namesFound = (result: unknown) =>
  (result as { tools: ReadonlyArray<{ name: string }> }).tools.map((tool) => tool.name)

describe("ToolSearch.toolkit", () => {
  it.effect("has two tools, whatever the toolkit it presents has", () =>
    Effect.gen(function* () {
      const few = yield* searchOver([define("ping")])
      const many = yield* searchOver(issueTools)

      expect(Object.keys(few.tools)).toEqual(["tool_search", "tool_call"])
      expect(Object.keys(many.tools)).toEqual(["tool_search", "tool_call"])
    })
  )

  it.effect("asks a model API not to use its strict schema mode for either tool", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      expect(Tool.getStrictMode(toolkit.tools.tool_search)).toBe(false)
      expect(Tool.getStrictMode(toolkit.tools.tool_call)).toBe(false)
    })
  )

  it.effect("tells the model how many tools it can search", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      expect(Tool.getDescription(toolkit.tools.tool_search)).toContain("6 tools")
    })
  )

  it.effect("contacts no source when it is made", () =>
    Effect.gen(function* () {
      const github = sourceOf()

      yield* searchOver(issueTools, github.source)

      expect(github.calls).toEqual([])
    })
  )
})

describe("tool_search", () => {
  it.effect("gives the name, description, and input schema of a tool it finds", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result, isFailure } = yield* search(toolkit, "close")

      expect(isFailure).toBe(false)
      expect(result).toEqual({
        tools: [
          {
            name: "github__close_issue",
            description: "Closes an issue",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"]
            }
          }
        ],
        matched: 1,
        available: 6
      })
    })
  )

  it.effect("leaves the description out for a tool that has none", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result } = yield* search(toolkit, "user")

      expect(result).toMatchObject({ tools: [{ name: "github__get_user" }] })
      expect((result as { tools: ReadonlyArray<object> }).tools[0]).not.toHaveProperty("description")
    })
  )

  it.effect("ranks a tool whose name has the words above one whose description has them", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result } = yield* search(toolkit, "pull request")

      // `create_pull_request` has both words in its name, and `create_issue` has neither.
      expect(namesFound(result)[0]).toBe("github__create_pull_request")
    })
  )

  it.effect("ranks a tool that matches more of the words above one that matches fewer", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result } = yield* search(toolkit, "create issue")

      // `create_issue` has both words in its name. `close_issue` has one in its name, and
      // `create_pull_request` has one in its name and one in its description, which are as good, so
      // they keep the order the tools have. `list_issues` only begins with one of the words.
      expect(namesFound(result)).toEqual([
        "github__create_issue",
        "github__close_issue",
        "github__create_pull_request",
        "github__list_issues"
      ])
    })
  )

  it.effect("matches the start of a word of a name, and words in any case or spelling", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver([
        define("createIssue"),
        define("createUser"),
        define("delete-branch"),
        define("Merge_Request")
      ])

      expect(namesFound((yield* search(toolkit, "issue")).result)).toEqual(["github__createIssue"])
      expect(namesFound((yield* search(toolkit, "create_issue")).result)).toEqual([
        "github__createIssue",
        "github__createUser"
      ])
      expect(namesFound((yield* search(toolkit, "BRANCH")).result)).toEqual(["github__delete-branch"])
      expect(namesFound((yield* search(toolkit, "mer")).result)).toEqual(["github__Merge_Request"])
    })
  )

  it.effect("finds a tool by its description when its name has no word of the query", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result } = yield* search(toolkit, "review")

      expect(namesFound(result)).toEqual(["github__create_pull_request"])
    })
  )

  it.effect("returns no tool, with the counts, when none matches", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result, isFailure } = yield* search(toolkit, "kubernetes")

      expect(isFailure).toBe(false)
      expect(result).toEqual({ tools: [], matched: 0, available: 6 })
    })
  )

  it.effect("returns the tools in order when the query has no words", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { result } = yield* search(toolkit, " -- ")

      expect(namesFound(result)).toEqual([
        "github__create_issue",
        "github__list_issues",
        "github__close_issue",
        "github__search_code",
        "github__create_pull_request"
      ])
      expect(result).toMatchObject({ matched: 6, available: 6 })
    })
  )

  it.effect("returns five tools by default and as many as asked up to twenty", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 30 }, (_, index) => define(`tool_${index}`, "A tool"))
      const toolkit = yield* searchOver(many)

      const byDefault = yield* search(toolkit, "tool")
      const asked = yield* search(toolkit, "tool", 12)
      const most = yield* search(toolkit, "tool", 20)

      expect(namesFound(byDefault.result)).toHaveLength(5)
      expect(namesFound(asked.result)).toHaveLength(12)
      expect(namesFound(most.result)).toHaveLength(20)
      expect(byDefault.result).toMatchObject({ matched: 30, available: 30 })
    })
  )

  it.effect("returns the number of tools the options give by default", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(issueTools, sourceOf().source, () => "allow", {
        limit: 2
      })

      const { result } = yield* search(toolkit, "issue")

      expect(namesFound(result)).toHaveLength(2)
      expect(result).toMatchObject({ matched: 4 })
    })
  )

  it.effect.each([0, 21, 2.5])("refuses a limit of %s, which the model reads", (limit) =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { isFailure } = yield* search(toolkit, "issue", limit)

      expect(isFailure).toBe(true)
    })
  )

  it.effect("does not find a tool the policy blocks", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(issueTools, sourceOf().source, (_source, definition) =>
        definition.name === "close_issue" ? "block" : "allow"
      )

      const { result } = yield* search(toolkit, "close")

      expect(result).toEqual({ tools: [], matched: 0, available: 5 })
    })
  )
})

describe("tool_call", () => {
  it.effect("runs the tool of that name with the input, and answers with its result", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* searchOver(issueTools, github.source)

      const { result, isFailure } = yield* call(toolkit, "tool_call", {
        name: "github__create_issue",
        input: { text: "Broken build" }
      })

      expect(isFailure).toBe(false)
      expect(result).toEqual({ ran: "create_issue", input: { text: "Broken build" } })
      expect(github.calls).toEqual([{ tool: "create_issue", input: { text: "Broken build" } }])
    })
  )

  it.effect("fails with NotFoundError for a name that is no tool, without running any", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* searchOver(issueTools, github.source)

      const named = yield* call(toolkit, "tool_call", { name: "github__nope", input: {} })
      const inherited = yield* call(toolkit, "tool_call", { name: "toString", input: {} })

      for (const { result, isFailure } of [named, inherited]) {
        expect(isFailure).toBe(true)
        expect(result).toMatchObject({ code: "NotFoundError", retryable: false })
        expect(JSON.stringify(result)).toContain("tool_search")
      }
      expect(github.calls).toEqual([])
    })
  )

  it.effect("does not run a tool the policy blocks", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* searchOver(issueTools, github.source, (_source, definition) =>
        definition.name === "close_issue" ? "block" : "allow"
      )

      const { result } = yield* call(toolkit, "tool_call", {
        name: "github__close_issue",
        input: { text: "1" }
      })

      expect(result).toMatchObject({ code: "NotFoundError" })
      expect(github.calls).toEqual([])
    })
  )

  it.effect("answers with the failure of the tool as it is, so that the model reads why", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(
        issueTools,
        sourceOf(() =>
          Effect.fail(
            new ToolSourceError.ToolSourceError({
              source: "github",
              reason: new ToolSourceError.CallFailedError({ description: "No such repository" })
            })
          )
        ).source
      )

      const { result, isFailure } = yield* call(toolkit, "tool_call", {
        name: "github__create_issue",
        input: { text: "x" }
      })

      expect(isFailure).toBe(true)
      expect(result).toEqual({
        code: "CallFailedError",
        message: "No such repository",
        retryable: false
      })
    })
  )

  it.effect("answers with the failure of an input the tool does not take", () =>
    Effect.gen(function* () {
      const github = sourceOf()
      const toolkit = yield* searchOver(issueTools, github.source)

      const { result, isFailure } = yield* call(toolkit, "tool_call", {
        name: "github__create_issue",
        input: { text: 4 }
      })

      expect(isFailure).toBe(true)
      expect(result).toMatchObject({ code: "InvalidInputError" })
      expect(github.calls).toEqual([])
    })
  )

  it.effect("refuses an input that is not an object, which the model reads", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver()

      const { isFailure } = yield* call(toolkit, "tool_call", {
        name: "github__create_issue",
        input: "Broken build"
      })

      expect(isFailure).toBe(true)
    })
  )

  it.effect("ends with the call when the call is interrupted, and so does the tool it runs", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const toolkit = yield* searchOver(
        issueTools,
        sourceOf(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
          )
        ).source
      )
      const calling = yield* Effect.forkChild(
        call(toolkit, "tool_call", { name: "github__create_issue", input: { text: "x" } })
      )
      yield* Deferred.await(started)

      yield* Fiber.interrupt(calling)

      expect(Exit.isFailure(yield* Fiber.await(calling))).toBe(true)
      yield* Deferred.await(interrupted)
    })
  )
})

describe("approval", () => {
  const approvalOf = (
    toolkit: Effect.Success<ReturnType<typeof searchOver>>,
    name: string,
    input: Schema.JsonObject = { text: "x" }
  ) =>
    Effect.gen(function* () {
      const needsApproval = toolkit.tools.tool_call.needsApproval
      if (typeof needsApproval !== "function") return needsApproval === true
      const decided = needsApproval({ name, input }, { toolCallId: "call-1", messages: [] })
      return typeof decided === "boolean" ? decided : yield* decided
    })

  it.effect("is needed for a call of a tool that needs it, and for no other", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(issueTools, sourceOf().source, (_source, definition) =>
        definition.name === "close_issue" ? "approve" : "allow"
      )

      expect(yield* approvalOf(toolkit, "github__close_issue")).toBe(true)
      expect(yield* approvalOf(toolkit, "github__create_issue")).toBe(false)
    })
  )

  it.effect("is not needed for a call that runs nothing", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(issueTools, sourceOf().source, () => "approve")

      expect(yield* approvalOf(toolkit, "github__no_such_tool")).toBe(false)
      expect(yield* approvalOf(toolkit, "toString")).toBe(false)
    })
  )

  it.effect("is not needed to search, which runs nothing", () =>
    Effect.gen(function* () {
      const toolkit = yield* searchOver(issueTools, sourceOf().source, () => "approve")

      expect(toolkit.tools.tool_search.needsApproval).toBeUndefined()
    })
  )

  it.effect("asks the tool's own question about the input the model gave", () =>
    Effect.gen(function* () {
      const Pay = Tool.make("Pay", {
        parameters: Schema.Struct({ amount: Schema.Finite }),
        success: Schema.String,
        needsApproval: ({ amount }) => amount > 100
      })
      const PayToolkit = Toolkit.make(Pay)
      const presented = yield* PayToolkit.pipe(
        Effect.provide(PayToolkit.toLayer({ Pay: ({ amount }) => Effect.succeed(`paid ${amount}`) }))
      )
      const toolkit = yield* ToolSearch.toolkit(presented)

      expect(yield* approvalOf(toolkit as never, "Pay", { amount: 500 })).toBe(true)
      expect(yield* approvalOf(toolkit as never, "Pay", { amount: 5 })).toBe(false)
    })
  )
})

describe("a toolkit of tools that are not dynamic", () => {
  const Add = Tool.make("Add", {
    description: "Adds two numbers",
    parameters: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
    success: Schema.Finite
  })
  const Fail = Tool.make("Fail", {
    description: "Always fails",
    parameters: Schema.Struct({}),
    success: Schema.String,
    failure: Schema.String
  })
  const Stream_ = Tool.make("Count", {
    description: "Counts to three, saying how far it got",
    parameters: Schema.Struct({}),
    success: Schema.String
  })
  const MathToolkit = Toolkit.make(Add, Fail, Stream_)
  const presented = MathToolkit.pipe(
    Effect.provide(
      MathToolkit.toLayer({
        Add: ({ a, b }) => Effect.succeed(a + b),
        Fail: () => Effect.fail("It always does"),
        Count: (_params, { preliminary }) => Effect.andThen(preliminary("one"), Effect.succeed("three"))
      })
    )
  )

  it.effect("finds its tools with the JSON Schema of their parameters", () =>
    Effect.gen(function* () {
      const toolkit = yield* Effect.flatMap(presented, (it) => ToolSearch.toolkit(it))

      const { result } = yield* call(toolkit as never, "tool_search", { query: "adds numbers" })

      expect(result).toMatchObject({
        tools: [
          {
            name: "Add",
            description: "Adds two numbers",
            inputSchema: { type: "object", required: ["a", "b"] }
          }
        ]
      })
    })
  )

  it.effect("runs one, and answers with the result it encodes", () =>
    Effect.gen(function* () {
      const toolkit = yield* Effect.flatMap(presented, (it) => ToolSearch.toolkit(it))

      const { result, isFailure } = yield* call(toolkit as never, "tool_call", {
        name: "Add",
        input: { a: 2, b: 3 }
      })

      expect(isFailure).toBe(false)
      expect(result).toBe(5)
    })
  )

  it.effect("answers with a failure for input the tool's schema refuses", () =>
    Effect.gen(function* () {
      const toolkit = yield* Effect.flatMap(presented, (it) => ToolSearch.toolkit(it))

      const { result, isFailure } = yield* call(toolkit as never, "tool_call", {
        name: "Add",
        input: { a: "two", b: 3 }
      })

      expect(isFailure).toBe(true)
      expect(result).toMatchObject({ code: "CallFailed", retryable: false })
    })
  )

  it.effect("answers with the text of a failure the tool's handler gave", () =>
    Effect.gen(function* () {
      const toolkit = yield* Effect.flatMap(presented, (it) => ToolSearch.toolkit(it))

      const { result, isFailure } = yield* call(toolkit as never, "tool_call", {
        name: "Fail",
        input: {}
      })

      expect(isFailure).toBe(true)
      expect(result).toEqual({ code: "CallFailed", message: "It always does", retryable: false })
    })
  )

  it.effect("answers with the final result, and not the preliminary ones before it", () =>
    Effect.gen(function* () {
      const toolkit = yield* Effect.flatMap(presented, (it) => ToolSearch.toolkit(it))

      const { result } = yield* call(toolkit as never, "tool_call", { name: "Count", input: {} })

      expect(result).toBe("three")
    })
  )
})
