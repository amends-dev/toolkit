/**
 * An assembly is the one toolkit a model is given for a turn, made of the tools of every source a
 * workspace has. `toolkit` names each tool by its source and its own name, leaves out the tools a
 * decision blocks, and marks the tools a decision asks about before they run. The model calls a
 * tool by that name, and the call reaches the source that owns the tool by the name that source
 * knows it by.
 *
 * Which of a tool's decisions is the right one is the host's to say, from what it has stored. A
 * source's hints are its own claims, so no decision is made from them here.
 *
 * @since 0.1.0
 */

import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import type * as ToolDefinition from "./ToolDefinition.ts"
import * as ToolSource from "./ToolSource.ts"
import * as ToolSourceError from "./ToolSourceError.ts"

/**
 * What the model may do with a tool: call it, call it once the person has approved the call, or not
 * be given it. A schema, so that a host can store its policy.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Decision = Schema.Literals(["allow", "approve", "block"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type Decision = typeof Decision.Type

/**
 * A source, with the definitions of the tools of it that the workspace has, from which `toolkit`
 * builds the model's tools without asking the source.
 *
 * @category models
 * @since 0.1.0
 */
export interface Member {
  readonly source: ToolSource.ToolSource

  /** The definitions of the source's tools that the host holds in its catalog. */
  readonly definitions: ReadonlyArray<ToolDefinition.ToolDefinition>
}

/**
 * Tools the model would know by one name, as `NameClash` reports them.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Clash = Schema.Struct({
  /** The name the model would know each of them by. */
  name: Schema.String,

  /** Each tool by its source's name for it, which is how it is told from the others. */
  tools: Schema.Array(Schema.Struct({ source: Schema.String, tool: Schema.String }))
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Clash extends Schema.Schema.Type<typeof Clash> {}

/**
 * More than one tool has the same name, so the model could not tell which one it calls. `toolkit`
 * fails with it, holding every clash.
 *
 * @category errors
 * @since 0.1.0
 */
export class NameClash extends Schema.TaggedError<NameClash>("@amends-dev/toolkit/Assembly/NameClash")("NameClash", {
  clashes: Schema.NonEmptyArray(Clash)
}) {
  override get message(): string {
    return this.clashes
      .map(
        ({ name, tools }) =>
          `${tools.map(({ source, tool }) => `${source}: ${tool}`).join(" and ")} are all named ${name}`
      )
      .join("; ")
  }
}

/** The longest name that the model APIs of Anthropic and OpenAI accept for a tool. */
const modelApiNameLength = 64

/** A name is cut to its fingerprint and an underscore at least, with a few characters before them. */
const shortestNameLength = 16

/**
 * What `toolkit` takes besides its members and the decision for each tool.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /**
   * The longest name a tool may have, for an agent that adds to the names it is given and so takes
   * fewer than the model APIs' 64 characters, such as an agent's `maxToolNameLength`. At least 16.
   */
  readonly maxNameLength?: number
}

/**
 * Builds the toolkit of `members`. The tools of a member that `decide` blocks are left out, and the
 * names of the others must be distinct, or the assembly fails with the names that are not.
 *
 * A model knows a tool by its source's name and its own, as `github__create_issue`, and a tool
 * that `decide` asks to `approve` needs approval before it runs. Building contacts none of the
 * sources.
 *
 * **Example** (The toolkit of a turn, from a workspace's sources and its policy)
 *
 * ```ts
 * import { Assembly, type ToolSource } from "@amends-dev/toolkit"
 * import { Effect } from "effect"
 *
 * declare const github: ToolSource.ToolSource
 * declare const linear: ToolSource.ToolSource
 * // What the host stored of each source: a decision for a tool, and the one for the others.
 * declare const policy: ReadonlyMap<
 *   string,
 *   { readonly tools: ReadonlyMap<string, Assembly.Decision>; readonly others: Assembly.Decision }
 * >
 *
 * const program = Effect.gen(function* () {
 *   // The definitions come from the host's catalog, filled from `discover` when it refreshed.
 *   const members = yield* Effect.forEach([github, linear], (source) =>
 *     Effect.map(source.discover, (definitions) => ({ source, definitions }))
 *   )
 *   const toolkit = yield* Assembly.toolkit(members, (source, definition) => {
 *     const stored = policy.get(source)
 *     return stored?.tools.get(definition.name) ?? stored?.others ?? "block"
 *   })
 *   // The model knows the tools as `github__create_issue`, and a call reaches its source.
 *   return toolkit
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolkit = Effect.fn("Assembly.toolkit")(function* (
  members: ReadonlyArray<Member>,
  decide: (source: string, definition: ToolDefinition.ToolDefinition) => Decision,
  options?: Options
) {
  const maxNameLength = options?.maxNameLength ?? modelApiNameLength
  if (!Number.isInteger(maxNameLength) || maxNameLength < shortestNameLength) {
    return yield* Effect.die(new Error(`maxNameLength must be a whole number of at least ${shortestNameLength}`))
  }
  const offered = members
    .flatMap(({ source, definitions }) =>
      definitions.map((definition) => ({
        source,
        definition,
        decision: decide(source.name, definition),
        name: nameOf(source.name, definition.name, maxNameLength)
      }))
    )
    .filter((tool) => tool.decision !== "block")

  const clashes = findClashes(
    offered.map(({ source, definition, name }) => ({
      name,
      source: source.name,
      tool: definition.name
    }))
  )
  if (Arr.isReadonlyArrayNonEmpty(clashes)) return yield* new NameClash({ clashes })

  const ownerOf = new Map(offered.map((tool) => [tool.name, tool]))
  const definitions = offered.map(({ definition, name }) => Struct.assign(definition, { name }))
  const approved = new Set(offered.filter((tool) => tool.decision === "approve").map((tool) => tool.name))
  const assembled: ToolSource.ToolSource = {
    name: "assembly",
    discover: Effect.succeed(definitions),
    call: (name, input) => {
      const owner = ownerOf.get(name)
      return owner === undefined
        ? Effect.fail(
            new ToolSourceError.ToolSourceError({
              source: "assembly",
              reason: new ToolSourceError.NotFoundError({})
            })
          )
        : owner.source.call(owner.definition.name, input)
    }
  }
  return yield* ToolSource.toolkit(assembled, definitions, {
    needsApproval: (definition) => approved.has(definition.name)
  })
})

/**
 * The name the model knows a tool by: its source's, then its own, in the characters agents accept. A
 * name that is too long is cut, and ends with a fingerprint of the whole name, so that tools whose
 * names differ only after the cut are still told apart, and a name is the same whenever it is made.
 */
const nameOf = (source: string, tool: string, maxNameLength: number) => {
  const whole = `${source}__${tool}`
  const safe = whole.replace(/[^A-Za-z0-9_-]/g, "_")
  if (safe.length <= maxNameLength) return safe
  const fingerprint = fingerprintOf(whole)
  return `${safe.slice(0, maxNameLength - fingerprint.length - 1)}_${fingerprint}`
}

/** Eight hexadecimal digits that are the same for the same text, and rarely for different texts. */
const fingerprintOf = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** The tools that share a name, for each name that more than one tool has, in the order met. */
const findClashes = (
  tools: ReadonlyArray<{ readonly name: string; readonly source: string; readonly tool: string }>
): ReadonlyArray<Clash> => {
  const byName = new Map<string, Array<{ readonly source: string; readonly tool: string }>>()
  for (const { name, source, tool } of tools) {
    byName.set(name, [...(byName.get(name) ?? []), { source, tool }])
  }
  return [...byName].filter(([, sharing]) => sharing.length > 1).map(([name, sharing]) => ({ name, tools: sharing }))
}
