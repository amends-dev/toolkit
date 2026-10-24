import { describe, expect, it } from "@effect/vitest"
import type { Schema } from "effect"
import { declare } from "../../src/internal/declarations.ts"

/** The declaration of one tool named `tool`, without the lines that wrap every declaration. */
const declared = (inputSchema: Schema.JsonObject, description?: string) =>
  declare([{ name: "tool", ...(description === undefined ? {} : { description }), inputSchema }])
    .split("\n")
    .slice(1, -1)
    .join("\n")

describe("declare", () => {
  it("declares the tools as the methods of an object named tools", () => {
    expect(
      declare([
        { name: "first", inputSchema: { type: "object" } },
        { name: "second", inputSchema: { type: "object" } }
      ])
    ).toBe(
      [
        "declare const tools: {",
        "  first(input?: Record<string, unknown>): Promise<unknown>;",
        "  second(input?: Record<string, unknown>): Promise<unknown>;",
        "};"
      ].join("\n")
    )
  })

  it("declares no tools as an object without methods", () => {
    expect(declare([])).toBe("declare const tools: {\n};")
  })

  it("makes the input optional unless it has a required property", () => {
    const properties = { text: { type: "string" } }

    expect(declared({ type: "object", properties })).toContain("tool(input?: {")
    expect(declared({ type: "object", properties, required: [] })).toContain("tool(input?: {")
    expect(declared({ type: "object", properties, required: ["text"] })).toContain("tool(input: {")
  })

  it("marks a property optional unless it is required, and quotes a name that is no identifier", () => {
    expect(
      declared({
        type: "object",
        properties: {
          title: { type: "string" },
          "x-trace": { type: "boolean" },
          $ok_1: { type: "null" }
        },
        required: ["title"]
      })
    ).toBe(
      [
        "  tool(input: {",
        "    title: string;",
        '    "x-trace"?: boolean;',
        "    $ok_1?: null;",
        "  }): Promise<unknown>;"
      ].join("\n")
    )
  })

  it("quotes the name of a tool that is no identifier", () => {
    expect(declare([{ name: "list-issues", inputSchema: { type: "object" } }])).toContain('  "list-issues"(input?')
  })

  it("writes a description as a comment, and a long one over lines that cannot end it early", () => {
    expect(
      declared(
        {
          type: "object",
          properties: { text: { type: "string", description: "The text */ it says" } }
        },
        "Opens an issue.\nIt is quick."
      )
    ).toBe(
      [
        "  /**",
        "   * Opens an issue.",
        "   * It is quick.",
        "   */",
        "  tool(input?: {",
        "    /** The text * / it says */",
        "    text?: string;",
        "  }): Promise<unknown>;"
      ].join("\n")
    )
  })

  it("leaves out a description that is blank", () => {
    expect(declared({ type: "object" }, "  ")).not.toContain("/**")
  })

  it.each([
    [{ type: "string" }, "string"],
    [{ type: "integer" }, "number"],
    [{ type: "number" }, "number"],
    [{ type: "boolean" }, "boolean"],
    [{ type: "null" }, "null"],
    [{ type: ["string", "null"] }, "string | null"],
    [{ type: "array", items: { type: "integer" } }, "Array<number>"],
    [{ type: "array" }, "Array<unknown>"],
    [{ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }, "[string, number]"],
    [{ enum: ["low", "high", 3, null, true] }, '"low" | "high" | 3 | null | true'],
    [{ const: "fixed" }, '"fixed"'],
    [{ anyOf: [{ type: "string" }, { type: "number" }, { type: "string" }] }, "string | number"],
    [{ oneOf: [{ const: 1 }, { const: 2 }] }, "1 | 2"],
    [{ allOf: [{ type: "string" }, { enum: ["a", "b"] }] }, 'string & ("a" | "b")'],
    [{ type: "object" }, "Record<string, unknown>"],
    [{ type: "object", additionalProperties: { type: "number" } }, "Record<string, number>"],
    [true, "unknown"],
    [false, "never"],
    [{ type: "mystery" }, "unknown"],
    [{}, "unknown"],
    [{ enum: [] }, "never"]
  ] as ReadonlyArray<readonly [Schema.Json, string]>)("declares the schema %j as %s", (schema, type) => {
    expect(declared({ type: "object", properties: { value: schema }, required: ["value"] })).toContain(
      `value: ${type};`
    )
  })

  it("reads an object without a type, and an array without one, by what it has", () => {
    expect(
      declared({
        type: "object",
        properties: {
          a: { properties: { b: { type: "string" } }, required: ["b"] },
          c: { items: { type: "string" } }
        }
      })
    ).toBe(
      [
        "  tool(input?: {",
        "    a?: {",
        "      b: string;",
        "    };",
        "    c?: Array<string>;",
        "  }): Promise<unknown>;"
      ].join("\n")
    )
  })

  it("allows other properties when the schema gives their type", () => {
    expect(
      declared({
        type: "object",
        properties: { text: { type: "string" } },
        additionalProperties: { type: "boolean" }
      })
    ).toBe(
      ["  tool(input?: {", "    text?: string;", "    [key: string]: boolean;", "  }): Promise<unknown>;"].join("\n")
    )
  })

  it("resolves a reference to the schema's own definitions, and stops at a cycle", () => {
    expect(
      declared({
        type: "object",
        properties: { repo: { $ref: "#/$defs/Repo" }, old: { $ref: "#/definitions/Repo" } },
        $defs: {
          Repo: {
            type: "object",
            properties: { name: { type: "string" }, parent: { $ref: "#/$defs/Repo" } }
          }
        },
        definitions: { Repo: { type: "string" } }
      })
    ).toBe(
      [
        "  tool(input?: {",
        "    repo?: {",
        "      name?: string;",
        "      parent?: unknown;",
        "    };",
        "    old?: string;",
        "  }): Promise<unknown>;"
      ].join("\n")
    )
  })

  it("declares a reference that leads nowhere as unknown", () => {
    expect(
      declared({
        type: "object",
        properties: {
          missing: { $ref: "#/$defs/Nothing" },
          elsewhere: { $ref: "https://example.com/schema" }
        }
      })
    ).toContain("missing?: unknown;")
  })

  it("ends a type nested deeper than six levels in unknown", () => {
    const nest = (levels: number): Schema.Json =>
      levels === 0 ? { type: "string" } : { type: "object", properties: { next: nest(levels - 1) }, required: ["next"] }

    expect(declared({ type: "object", properties: { deep: nest(3) } })).toContain("string;")
    expect(declared({ type: "object", properties: { deep: nest(12) } })).toContain("unknown;")
    expect(declared({ type: "object", properties: { deep: nest(12) } })).not.toContain("string;")
  })
})
