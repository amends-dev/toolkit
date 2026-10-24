import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ToolDefinition from "../src/ToolDefinition.ts"

const json = Schema.toCodecJson(ToolDefinition.ToolDefinition)

/** A definition as an MCP server might report it, with keywords the definition does not name. */
const search = {
  name: "search",
  description: "Searches the notes",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "What to look for" } },
    required: ["query"],
    additionalProperties: false,
    $defs: { text: { type: "string" } }
  },
  annotations: { title: "Search", readOnly: true, openWorld: false }
}

const decode = (value: unknown) => Schema.decodeUnknownEffect(json)(value)

describe("ToolDefinition", () => {
  it.effect("keeps what a source reported, through JSON and back", () =>
    Effect.gen(function* () {
      const definition = yield* decode(JSON.parse(JSON.stringify(search)))
      const stored = JSON.stringify(yield* Schema.encodeEffect(json)(definition))

      expect(definition).toEqual(search)
      expect(JSON.parse(stored)).toEqual(search)
    })
  )

  it.effect("leaves out what a source did not report, rather than filling it in", () =>
    Effect.gen(function* () {
      const reported = { name: "ping", inputSchema: { type: "object" }, annotations: {} }

      const definition = yield* decode(reported)

      // Hints left out stay out, so the default of Effect AI's annotation applies at runtime.
      expect(definition).toEqual(reported)
      expect(Object.keys(definition)).not.toContain("description")
      expect(Object.keys(definition.annotations)).toEqual([])
    })
  )

  it.effect("refuses parameters that are not an object schema", () =>
    Effect.gen(function* () {
      const notAnObject = { ...search, inputSchema: { type: "string" } }
      const missing = { name: "search", annotations: {} }

      expect(Schema.isSchemaError(yield* Effect.flip(decode(notAnObject)))).toBe(true)
      expect(Schema.isSchemaError(yield* Effect.flip(decode(missing)))).toBe(true)
    })
  )

  it.effect("refuses a tool without a name, and a hint that is not a boolean", () =>
    Effect.gen(function* () {
      const unnamed = { ...search, name: "" }
      const unsure = { ...search, annotations: { readOnly: "yes" } }

      expect(Schema.isSchemaError(yield* Effect.flip(decode(unnamed)))).toBe(true)
      expect(Schema.isSchemaError(yield* Effect.flip(decode(unsure)))).toBe(true)
    })
  )
})
