/**
 * Search is a way to show a model a large set of tools, or one that changes from turn to turn. The
 * model is given two tools in place of one for each: `tool_search`, which finds tools by what they
 * do and tells their parameters, and `tool_call`, which runs one of them by its name. What the model
 * is shown stays the same however many tools there are, and costs the tokens of what it searched
 * for, not of the whole set.
 *
 * `toolkit` makes that toolkit from the one it presents, which is the model's to search and call.
 * Running a tool is the presented toolkit's own, so what it decides stays decided: a tool that needs
 * approval needs it when the model calls it through `tool_call`, and a call fails as it fails there.
 *
 * @since 0.1.0
 */

import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Presentation from "./Presentation.ts"
import * as ToolSource from "./ToolSource.ts"

/** The most tools a search may return, which a call can ask for fewer of. */
const maxLimit = 20

const defaultLimit = 5

/** What `tool_search` tells of a tool: what the model needs to call it. */
const Found = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),

  /** The tool's parameters, as a JSON Schema. */
  inputSchema: Schema.Json
})

const SearchResult = Schema.Struct({
  /** The tools that match best, best first. */
  tools: Schema.Array(Found),

  /** How many tools match, which is more than `tools` holds when the search was cut short. */
  matched: Schema.Int,

  /** How many tools there are to search. */
  available: Schema.Int
})

/** The tools of a presented toolkit, as the search reads them. */
interface Entry {
  readonly found: typeof Found.Type
  readonly nameWords: ReadonlyArray<string>
  readonly descriptionWords: ReadonlyArray<string>
}

/**
 * What `toolkit` takes besides the toolkit it presents.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** How many tools a search returns when it does not ask for a number. Five by default. */
  readonly limit?: number
}

/**
 * Makes the toolkit of `tool_search` and `tool_call` over `presented`. Building contacts nothing.
 *
 * **Example** (Presenting a large set of tools as a search)
 *
 * ```ts
 * import { Assembly, ToolSearch } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 *
 * declare const members: ReadonlyArray<Assembly.Member> // an API's hundreds of operations
 *
 * const program = Effect.gen(function* () {
 *   const assembled = yield* Assembly.toolkit(members, () => "allow")
 *   // The model is shown `tool_search` and `tool_call`, however many tools there are.
 *   return yield* ToolSearch.toolkit(assembled, { limit: 10 })
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolkit = Effect.fn("ToolSearch.toolkit")(function* <Tools extends Record<string, Tool.Any>>(
  presented: Toolkit.WithHandler<Tools>,
  options?: Options
) {
  const services = yield* Effect.context<Tool.HandlerServices<Tools[keyof Tools]>>()
  const entries = Object.values<Tool.Any>(presented.tools).map(entryOf)
  const limit = options?.limit ?? defaultLimit

  const Search = Tool.make("tool_search", {
    description:
      `Searches the ${entries.length} tools you can run with tool_call, by what they do. ` +
      "Tells the name, description, and input schema of the tools that match best. " +
      "Search again with other words when nothing fits.",
    parameters: Schema.Struct({
      query: Schema.String.annotate({ description: "Words for what the tool should do" }),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxLimit })).annotate({
          description: `How many tools to return, at most ${maxLimit}. ${limit} by default`
        })
      )
    }),
    success: SearchResult,
    failure: ToolSource.Failure,
    // A model that searches wrongly is told so, and tries again.
    failureMode: "return"
  })

  const Call = Tool.make("tool_call", {
    description:
      "Runs a tool that tool_search found, by its name, with an input that matches the input " +
      "schema tool_search gave. Search for a tool before you call it.",
    parameters: Schema.Struct({
      name: Schema.String.annotate({ description: "The name of the tool, as tool_search gave it" }),
      input: Schema.JsonObject.annotate({ description: "The tool's input" })
    }),
    success: Schema.Json,
    failure: ToolSource.Failure,
    failureMode: "return",
    needsApproval: ({ name, input }, context) => {
      const needsApproval = presented.tools[name]?.needsApproval
      return typeof needsApproval === "function" ? needsApproval(input, context) : needsApproval === true
    }
  })

  // Neither is sent in strict schema mode: a search may leave out `limit`, and a call's input is
  // whatever the tool it names takes, which strict mode does not allow.
  const SearchToolkit = Toolkit.make(Search.annotate(Tool.Strict, false), Call.annotate(Tool.Strict, false))
  const handlers = SearchToolkit.toLayer({
    tool_search: ({ query, limit: asked }) =>
      Effect.sync(() => {
        const matches = search(entries, query)
        return {
          tools: matches.slice(0, asked ?? limit).map((entry) => entry.found),
          matched: matches.length,
          available: entries.length
        }
      }),

    tool_call: ({ name, input }) =>
      (Presentation.hasTool(presented, name)
        ? Presentation.call(presented, name, input)
        : Effect.fail(
            Presentation.failure("NotFoundError", `There is no tool named ${name}. Search for one with tool_search`)
          )
      ).pipe(Effect.provide(services))
  })
  return yield* SearchToolkit.pipe(Effect.provide(handlers))
})

/** What a search reads of a tool. */
const entryOf = (tool: Tool.Any): Entry => {
  const description = Tool.getDescription(tool)
  return {
    found: {
      name: tool.name,
      ...(description === undefined ? {} : { description }),
      inputSchema: Presentation.inputSchemaOf(tool)
    },
    nameWords: wordsOf(tool.name),
    descriptionWords: wordsOf(description ?? "")
  }
}

/**
 * The words of a text, in lower case: runs of letters and digits, which a change of case within
 * letters splits, so that `createIssue`, `create_issue` and `create-issue` have the same words.
 */
const wordsOf = (text: string): ReadonlyArray<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")

/**
 * The tools that match `query`, best first, and the tools in order when it has no words. A word of
 * the query scores for a word of the tool's name that is the same, or that it begins, and for one of
 * its description; the name counts for most. A tool that scores nothing does not match.
 */
const search = (entries: ReadonlyArray<Entry>, query: string): ReadonlyArray<Entry> => {
  const queryWords = wordsOf(query)
  if (queryWords.length === 0) return entries
  return entries
    .map((entry) => ({ entry, score: scoreOf(entry, queryWords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)
}

const scoreOf = (entry: Entry, queryWords: ReadonlyArray<string>) =>
  queryWords.reduce(
    (score, word) =>
      score +
      (entry.nameWords.includes(word) ? 4 : entry.nameWords.some((it) => it.startsWith(word)) ? 2 : 0) +
      (entry.descriptionWords.includes(word) ? 1 : 0),
    0
  )
