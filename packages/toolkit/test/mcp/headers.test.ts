import { describe, expect, it } from "@effect/vitest"
import { Result, type Schema } from "effect"
import { encodeHeaderValue, findBindings, headersOf } from "../../src/internal/mcpHeaders.ts"

const schemaOf = (properties: Schema.Json): Schema.JsonObject => ({ type: "object", properties })

const bindingsOf = (schema: Schema.JsonObject) =>
  Result.match(findBindings(schema), {
    onSuccess: (bindings) => bindings,
    onFailure: (reason) => reason
  })

const mark = (name: Schema.Json, type: Schema.Json = "string"): Schema.JsonObject => ({
  type,
  "x-mcp-header": name
})

describe("the value of a header", () => {
  // The rows of the table that the protocol gives, with the bytes it gives for each.
  it.each([
    ["us-west1", "us-west1"],
    ["us west 1", "us west 1"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    ["日本語", "=?base64?5pel5pys6Kqe?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    [" us-west1", "=?base64?IHVzLXdlc3Qx?="],
    ["us-west1 ", "=?base64?dXMtd2VzdDEg?="],
    [" us-west1 ", "=?base64?IHVzLXdlc3QxIA==?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["line1\r\nline2", "=?base64?bGluZTENCmxpbmUy?="],
    ["\tindented", "=?base64?CWluZGVudGVk?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="]
  ])("is %j as %s", (text, value) => {
    expect(encodeHeaderValue(text)).toBe(value)
  })

  it("holds a text with a tab inside as base64, as a text with any control character", () => {
    expect(encodeHeaderValue("a\tb")).toBe("=?base64?YQli?=")
    expect(encodeHeaderValue("a\u007fb")).toMatch(/^=\?base64\?.*\?=$/)
  })

  it("holds a text that only starts or only ends as the base64 form does as itself", () => {
    expect(encodeHeaderValue("=?base64?x")).toBe("=?base64?x")
    expect(encodeHeaderValue("x?=")).toBe("x?=")
  })

  it("is the text itself when a header can hold it, even one that is all punctuation", () => {
    expect(encodeHeaderValue("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")).toBe("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
  })
})

describe("the headers of a call", () => {
  const region = [{ headerName: "Region", path: ["region"] }]

  it("is a header for each parameter that has a value", () => {
    const bindings = [
      { headerName: "Region", path: ["region"] },
      { headerName: "Shard", path: ["shard"] },
      { headerName: "Dry-Run", path: ["dryRun"] },
      { headerName: "Ratio", path: ["ratio"] }
    ]

    const headers = headersOf(bindings, {
      region: "us-west1",
      shard: 42,
      dryRun: false,
      ratio: 0.75
    })

    expect(headers).toEqual({
      "mcp-param-region": "us-west1",
      "mcp-param-shard": "42",
      "mcp-param-dry-run": "false",
      "mcp-param-ratio": "0.75"
    })
  })

  it("has none for a parameter that the input leaves out or gives as null", () => {
    expect(headersOf(region, { query: "x" })).toEqual({})
    expect(headersOf(region, { region: null })).toEqual({})
  })

  it("finds a parameter below other properties, and has none when the path ends at something else", () => {
    const nested = [{ headerName: "Nested-Region", path: ["routing", "region"] }]

    expect(headersOf(nested, { routing: { region: "eu" } })).toEqual({
      "mcp-param-nested-region": "eu"
    })
    expect(headersOf(nested, { routing: "eu" })).toEqual({})
    expect(headersOf(nested, { routing: null })).toEqual({})
  })

  it("encodes a value that a header cannot hold, and so lets no value add a header", () => {
    expect(headersOf(region, { region: "eu\r\nx-evil: 1" })).toEqual({
      "mcp-param-region": `=?base64?ZXUNCngtZXZpbDogMQ==?=`
    })
    expect(headersOf(region, { region: "Région" })["mcp-param-region"]).toMatch(/^=\?base64\?/)
  })

  it("has none for a number that is not finite, which JSON has not", () => {
    expect(headersOf(region, { region: Infinity })).toEqual({})
    expect(headersOf(region, { region: NaN })).toEqual({})
  })

  it("has none for a value that is no string, number, or boolean, or no number the body says exactly", () => {
    expect(headersOf(region, { region: { a: 1 } })).toEqual({})
    expect(headersOf(region, { region: ["a"] })).toEqual({})
    expect(headersOf(region, { region: 2 ** 53 })).toEqual({})
    expect(headersOf(region, { region: 2 ** 53 - 1 })).toEqual({
      "mcp-param-region": "9007199254740991"
    })
    expect(headersOf(region, { region: -7 })).toEqual({ "mcp-param-region": "-7" })
  })
})

describe("the marks of a tool", () => {
  it("are the parameters that carry them, with the headers they are sent as", () => {
    const schema = schemaOf({
      region: { type: "string", "x-mcp-header": "Region", description: "Where to run the query" },
      query: { type: "string" }
    })

    expect(bindingsOf(schema)).toEqual([{ headerName: "Region", path: ["region"] }])
  })

  it("are none for a tool that has none", () => {
    expect(bindingsOf(schemaOf({ query: { type: "string" } }))).toEqual([])
    expect(bindingsOf({ type: "object" })).toEqual([])
  })

  it("may be below properties of properties", () => {
    const schema = schemaOf({
      region: mark("Region"),
      routing: { type: "object", properties: { region: mark("Nested-Region") } }
    })

    expect(bindingsOf(schema)).toEqual([
      { headerName: "Region", path: ["region"] },
      { headerName: "Nested-Region", path: ["routing", "region"] }
    ])
  })

  it("may be on a string, an integer, a number, or a boolean", () => {
    const schema = schemaOf({
      a: mark("A", "string"),
      b: mark("B", "integer"),
      c: mark("C", "number"),
      d: mark("D", "boolean")
    })

    expect(bindingsOf(schema)).toHaveLength(4)
  })

  it("may be named as a standard header is, which makes another header", () => {
    expect(bindingsOf(schemaOf({ method: mark("Method") }))).toEqual([{ headerName: "Method", path: ["method"] }])
  })

  it.each([
    ["is empty", ""],
    ["has a space", "My Region"],
    ["has a colon", "Region:Primary"],
    ["has a letter that is not ASCII", "Région"],
    ["has a tab", "Region\t1"],
    ["has a line feed", "Region\n1"],
    ["is a number", 7],
    ["is null", null]
  ])("make the tool unusable when a name %s", (_, name) => {
    expect(bindingsOf(schemaOf({ region: mark(name) }))).toContain("region")
  })

  it("make the tool unusable when two have the same name, whatever the case", () => {
    const same = schemaOf({ a: mark("Region"), b: mark("Region") })
    const differing = schemaOf({ a: mark("Region"), b: mark("REGION") })

    expect(bindingsOf(same)).toContain("another property")
    expect(bindingsOf(differing)).toContain("another property")
  })

  it.each([
    ["an array", { type: "array", "x-mcp-header": "A" }],
    ["an object", { type: "object", "x-mcp-header": "A" }],
    ["a null", { type: "null", "x-mcp-header": "A" }],
    ["no type", { "x-mcp-header": "A" }],
    ["a type that is a list", { type: ["string", "null"], "x-mcp-header": "A" }],
    ["a type that is a reference", { $ref: "#/$defs/A", "x-mcp-header": "A" }]
  ])("make the tool unusable on %s", (_, property) => {
    expect(bindingsOf(schemaOf({ a: property }))).toContain("only allowed on a string")
  })

  it.each([
    ["the root", { type: "string", "x-mcp-header": "A" }],
    ["items", schemaOf({ a: { type: "array", items: mark("A") } })],
    ["a list of items", schemaOf({ a: { type: "array", items: [mark("A")] } })],
    ["prefixItems", schemaOf({ a: { type: "array", prefixItems: [mark("A")] } })],
    ["additionalProperties", { type: "object", additionalProperties: mark("A") }],
    ["anyOf", schemaOf({ a: { anyOf: [mark("A"), { type: "null" }] } })],
    ["oneOf", schemaOf({ a: { oneOf: [mark("A")] } })],
    ["allOf", { allOf: [schemaOf({ a: mark("A") })] }],
    ["not", schemaOf({ a: { not: mark("A") } })],
    [
      "then",
      schemaOf({
        a: JSON.parse('{"if":{"type":"string"},"then":{"type":"string","x-mcp-header":"A"}}') as Schema.Json
      })
    ],
    ["$defs", { type: "object", properties: {}, $defs: { A: mark("A") } }],
    ["properties of $defs", { type: "object", properties: {}, $defs: { O: schemaOf({ a: mark("A") }) } }],
    ["patternProperties", { type: "object", patternProperties: { "^x": mark("A") } }],
    ["definitions", { type: "object", definitions: { A: mark("A") } }],
    ["dependentSchemas", { type: "object", dependentSchemas: { a: mark("A") } }],
    ["if", schemaOf({ a: { if: mark("A") } })],
    ["else", schemaOf({ a: { else: mark("A") } })],
    ["contains", schemaOf({ a: { type: "array", contains: mark("A") } })],
    ["propertyNames", { type: "object", propertyNames: mark("A") }],
    ["unevaluatedProperties", { type: "object", unevaluatedProperties: mark("A") }],
    ["unevaluatedItems", schemaOf({ a: { type: "array", unevaluatedItems: mark("A") } })]
  ])("make the tool unusable below %s, which no chain of properties leads to", (_, schema) => {
    expect(bindingsOf(schema)).toContain('"properties" lead to from the root')
  })

  it("are not found in a value, or in a property that has their name", () => {
    const schema = schemaOf({
      "x-mcp-header": { type: "string" },
      choice: {
        type: "string",
        default: { "x-mcp-header": "Nope" },
        enum: [{ "x-mcp-header": "Nope" }],
        examples: [{ "x-mcp-header": "Nope" }]
      }
    })

    expect(bindingsOf(schema)).toEqual([])
  })
})
