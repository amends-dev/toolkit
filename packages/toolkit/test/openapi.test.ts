import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, Stream, Struct } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Http from "../src/Http.ts"
import * as OpenApi from "../src/OpenApi.ts"
import * as ToolSource from "../src/ToolSource.ts"

/** A document with these paths, and these parts of its components. */
const specOf = (
  paths: Schema.JsonObject,
  options: {
    readonly components?: Schema.JsonObject
    readonly version?: string
    readonly servers?: Schema.Json
  } = {}
): Schema.JsonObject => ({
  openapi: options.version ?? "3.1.0",
  info: { title: "Example", version: "1" },
  ...(options.servers === undefined ? {} : { servers: options.servers }),
  paths,
  ...(options.components === undefined ? {} : { components: options.components })
})

const read = (spec: Schema.JsonObject) => OpenApi.readOperations(spec)

const operationOf = (imported: OpenApi.Imported, name: string) => {
  const found = imported.operations.find((operation) => operation.definition.name === name)
  if (found === undefined) throw new Error(`No operation named ${name}`)
  return found
}

const skippedOf = (spec: Schema.JsonObject) => Effect.map(read(spec), (imported) => imported.skipped)

describe("OpenApi.readOperations", () => {
  const pets = specOf(
    {
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Find a pet",
          description: "Returns a pet by its id.",
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              description: "The pet",
              schema: { type: "integer" }
            },
            { name: "expand", in: "query", schema: { type: "array", items: { type: "string" } } }
          ]
        },
        delete: {
          operationId: "deletePet",
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }]
        }
      },
      "/pets": {
        post: {
          summary: "Add a pet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } } }
              }
            }
          }
        },
        get: { operationId: "listPets" },
        put: { operationId: "replacePets" },
        patch: { operationId: "patchPets" },
        head: { operationId: "headPets" },
        options: { operationId: "optionPets" },
        trace: { operationId: "tracePets" }
      }
    },
    {
      servers: [
        { url: "https://{region}.pets.example/v1", variables: { region: { default: "eu" } } },
        { url: "https://pets.example" },
        { url: "https://pets.example" },
        { description: "No address" }
      ]
    }
  )

  it.effect("makes a tool of each operation, named by its operation id or else by its method and path", () =>
    Effect.gen(function* () {
      const imported = yield* read(pets)

      expect(imported.operations.map((operation) => operation.definition.name)).toEqual([
        "getPet",
        "deletePet",
        "listPets",
        "replacePets",
        "post_pets",
        "optionPets",
        "headPets",
        "patchPets"
      ])
      expect(imported.skipped).toEqual([])
    })
  )

  it.effect("describes a tool by the summary and the description, and gives it what HTTP says of its method", () =>
    Effect.gen(function* () {
      const imported = yield* read(pets)

      expect(operationOf(imported, "getPet").definition.description).toBe("Find a pet\n\nReturns a pet by its id.")
      expect(operationOf(imported, "post_pets").definition.description).toBe("Add a pet")
      expect(operationOf(imported, "listPets").definition.description).toBeUndefined()
      expect(
        ["getPet", "headPets", "optionPets", "replacePets", "post_pets", "patchPets", "deletePet"].map((name) => {
          const { title, ...hints } = operationOf(imported, name).definition.annotations
          return [name, title, hints] as const
        })
      ).toEqual([
        ["getPet", "Find a pet", { readOnly: true, idempotent: true }],
        ["headPets", undefined, { readOnly: true, idempotent: true }],
        ["optionPets", undefined, { readOnly: true, idempotent: true }],
        ["replacePets", undefined, { readOnly: false, idempotent: true }],
        ["post_pets", "Add a pet", { readOnly: false, idempotent: false }],
        ["patchPets", undefined, { readOnly: false, idempotent: false }],
        ["deletePet", undefined, { readOnly: false, idempotent: true, destructive: true }]
      ])
    })
  )

  it.effect("describes a tool once when its summary and its description say the same", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({ "/a": { get: { operationId: "a", summary: "Lists", description: "Lists" } } })
      )

      expect(operationOf(imported, "a").definition.description).toBe("Lists")
    })
  )

  it.effect("gives the addresses of the servers, with their variables filled in, and no address twice", () =>
    Effect.gen(function* () {
      const imported = yield* read(pets)

      expect(imported.servers).toEqual(["https://eu.pets.example/v1", "https://pets.example"])
    })
  )

  it.effect("makes the input of a tool of its parameters and its body", () =>
    Effect.gen(function* () {
      const imported = yield* read(pets)

      expect(operationOf(imported, "getPet").definition.inputSchema).toEqual({
        type: "object",
        properties: {
          petId: { type: "integer", description: "The pet" },
          expand: { type: "array", items: { type: "string" } }
        },
        required: ["petId"],
        additionalProperties: false
      })
      expect(operationOf(imported, "post_pets").definition.inputSchema).toEqual({
        type: "object",
        properties: { body: { type: "object", properties: { name: { type: "string" } } } },
        required: ["body"],
        additionalProperties: false
      })
      expect(operationOf(imported, "listPets").definition.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false
      })
    })
  )

  it.effect("makes the request of a tool of the method, the path, and where each property goes", () =>
    Effect.gen(function* () {
      const imported = yield* read(pets)

      expect(operationOf(imported, "getPet").request).toEqual({
        method: "GET",
        path: "/pets/{petId}",
        parameters: [
          { in: "path", name: "petId", property: "petId" },
          { in: "query", name: "expand", property: "expand" }
        ]
      })
      expect(operationOf(imported, "post_pets").request).toEqual({
        method: "POST",
        path: "/pets",
        parameters: [],
        body: "body"
      })
    })
  )

  it.effect("reads a parameter of the path as one of the operation when the operation has its own", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({
          "/things/{id}": {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "limit", in: "query", schema: { type: "integer", maximum: 10 } }
            ],
            get: {
              operationId: "getThing",
              parameters: [
                {
                  name: "limit",
                  in: "query",
                  required: true,
                  schema: { type: "integer", maximum: 50 }
                }
              ]
            }
          }
        })
      )

      expect(operationOf(imported, "getThing").definition.inputSchema).toMatchObject({
        properties: { id: { type: "string" }, limit: { type: "integer", maximum: 50 } },
        required: ["id", "limit"]
      })
    })
  )

  it.effect("takes a parameter without a schema as a string, and a path parameter as required", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({
          "/things/{id}": {
            get: {
              operationId: "getThing",
              parameters: [
                { name: "id", in: "path", schema: { type: "string" } },
                { name: "q", in: "query" }
              ]
            }
          }
        })
      )

      expect(operationOf(imported, "getThing").definition.inputSchema).toMatchObject({
        properties: { id: { type: "string" }, q: { type: "string" } },
        required: ["id"]
      })
    })
  )
})

describe("the names of the properties of a tool's input", () => {
  const inputOf = (parameters: Schema.Json, extra: Schema.JsonObject = {}) =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({
          "/things/{id}": { post: Struct.assign({ operationId: "act", parameters }, extra) }
        })
      )
      return operationOf(imported, "act")
    })
  const pathId = { name: "id", in: "path", required: true, schema: { type: "string" } }

  it.effect("put the place before a name that two parameters have", () =>
    Effect.gen(function* () {
      const operation = yield* inputOf([pathId, { name: "id", in: "query", schema: { type: "string" } }])

      expect(Object.keys(operation.definition.inputSchema.properties ?? {})).toEqual(["path_id", "query_id"])
      expect(operation.request.parameters).toEqual([
        { in: "path", name: "id", property: "path_id" },
        { in: "query", name: "id", property: "query_id" }
      ])
    })
  )

  it.effect("put the place before `body` when a parameter is called that and the operation has a body", () =>
    Effect.gen(function* () {
      const operation = yield* inputOf([pathId, { name: "body", in: "query", schema: { type: "string" } }], {
        requestBody: { content: { "application/json": { schema: { type: "object" } } } }
      })

      expect(Object.keys(operation.definition.inputSchema.properties ?? {})).toEqual(["id", "query_body", "body"])
    })
  )

  it.effect("have only the characters an agent accepts, and the request keeps the name it has", () =>
    Effect.gen(function* () {
      const operation = yield* inputOf([
        pathId,
        { name: "filter[status]", in: "query", schema: { type: "string" } },
        { name: "X-Request-Id", in: "header", schema: { type: "string" } }
      ])

      expect(Object.keys(operation.definition.inputSchema.properties ?? {})).toEqual([
        "id",
        "filter_status_",
        "X-Request-Id"
      ])
      expect(operation.request.parameters[1]).toEqual({
        in: "query",
        name: "filter[status]",
        property: "filter_status_"
      })
    })
  )

  it.effect("are no longer than agents accept", () =>
    Effect.gen(function* () {
      const operation = yield* inputOf([pathId, { name: "a".repeat(80), in: "query", schema: { type: "string" } }])

      expect(Object.keys(operation.definition.inputSchema.properties ?? {})).toEqual(["id", "a".repeat(64)])
      expect(operation.request.parameters[1]?.name).toBe("a".repeat(80))
    })
  )

  it.effect("leave out the headers a client decides, and the cookies nobody needs", () =>
    Effect.gen(function* () {
      const operation = yield* inputOf([
        pathId,
        { name: "Accept", in: "header", schema: { type: "string" } },
        { name: "Content-Type", in: "header", schema: { type: "string" } },
        { name: "authorization", in: "header", schema: { type: "string" } },
        { name: "session", in: "cookie", schema: { type: "string" } }
      ])

      expect(Object.keys(operation.definition.inputSchema.properties ?? {})).toEqual(["id"])
    })
  )
})

describe("the schemas of a tool's input", () => {
  const components = {
    schemas: {
      Pet: {
        type: "object",
        properties: { name: { type: "string" }, owner: { $ref: "#/components/schemas/Owner" } },
        required: ["name"]
      },
      Owner: {
        type: "object",
        properties: { pets: { type: "array", items: { $ref: "#/components/schemas/Pet" } } }
      },
      "Weird Name/1": { type: "string" },
      "Weird_Name/1": { type: "integer" }
    },
    parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer" } } },
    requestBodies: {
      NewPet: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } }
      }
    }
  }

  it.effect("stand alone, with the schemas they refer to, which may refer to each other and to themselves", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf(
          {
            "/pets": {
              post: {
                operationId: "addPet",
                parameters: [{ $ref: "#/components/parameters/Limit" }],
                requestBody: { $ref: "#/components/requestBodies/NewPet" }
              }
            }
          },
          { components }
        )
      )

      const input = operationOf(imported, "addPet").definition.inputSchema
      expect(input.properties).toEqual({
        limit: { type: "integer" },
        body: { $ref: "#/$defs/Pet" }
      })
      expect(input.required).toEqual(["body"])
      expect(input["$defs"]).toEqual({
        Pet: {
          type: "object",
          properties: { name: { type: "string" }, owner: { $ref: "#/$defs/Owner" } },
          required: ["name"]
        },
        Owner: {
          type: "object",
          properties: { pets: { type: "array", items: { $ref: "#/$defs/Pet" } } }
        }
      })
    })
  )

  it.effect("are keys of their own, in the characters a reference holds, even when names would be one", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf(
          {
            "/x": {
              post: {
                operationId: "x",
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        prefixItems: [{ $ref: "#/components/schemas/Weird Name~11" }],
                        items: { $ref: "#/components/schemas/Weird_Name~11" }
                      }
                    }
                  }
                }
              }
            }
          },
          {
            components: {
              schemas: {
                "Weird Name/1": { type: "string" },
                "Weird_Name/1": { type: "integer" }
              }
            }
          }
        )
      )

      const input = operationOf(imported, "x").definition.inputSchema
      expect(input.properties?.["body"]).toEqual({
        type: "array",
        prefixItems: [{ $ref: "#/$defs/Weird_Name_1" }],
        items: { $ref: "#/$defs/Weird_Name_1_2" }
      })
      expect(input["$defs"]).toEqual({
        Weird_Name_1: { type: "string" },
        Weird_Name_1_2: { type: "integer" }
      })
    })
  )

  it.effect("are keys of their own for a schema and the schema it refers to, when their names would be one", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf(
          {
            "/x": {
              post: {
                operationId: "x",
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/A b" } }
                  }
                }
              }
            }
          },
          {
            components: {
              schemas: {
                "A b": {
                  type: "object",
                  properties: { next: { $ref: "#/components/schemas/A_b" } }
                },
                A_b: { type: "string" }
              }
            }
          }
        )
      )

      expect(operationOf(imported, "x").definition.inputSchema["$defs"]).toEqual({
        A_b: { type: "object", properties: { next: { $ref: "#/$defs/A_b_2" } } },
        A_b_2: { type: "string" }
      })
    })
  )

  it.effect("are checked as the tool is called, with the references followed", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf(
          {
            "/pets": {
              post: {
                operationId: "addPet",
                requestBody: { $ref: "#/components/requestBodies/NewPet" }
              }
            }
          },
          { components }
        )
      )
      const source: ToolSource.ToolSource = {
        name: "pets",
        discover: Effect.die("not asked"),
        call: () => Effect.succeed("ran")
      }
      const toolkit = yield* ToolSource.toolkit(
        source,
        imported.operations.map((operation) => operation.definition)
      )
      const call = (params: unknown) =>
        toolkit.handle("addPet", params).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.map((results) => results[results.length - 1]?.isFailure)
        )

      expect(yield* call({ body: { name: "Rex" } })).toBe(false)
      expect(yield* call({ body: { name: 7 } })).toBe(true)
      expect(yield* call({ body: { owner: {} } })).toBe(true)
      expect(yield* call({})).toBe(true)
    })
  )

  it.effect("are made of what OpenAPI 3.0 writes as 3.1 writes it", () =>
    Effect.gen(function* () {
      const schema = (property: Schema.Json) => ({
        "/x": {
          post: {
            operationId: "x",
            requestBody: { content: { "application/json": { schema: property } } }
          }
        }
      })
      const bodyOf = (version: string, property: Schema.Json) =>
        Effect.map(
          read(specOf(schema(property), { version })),
          (imported) => operationOf(imported, "x").definition.inputSchema.properties?.["body"]
        )

      expect(yield* bodyOf("3.0.3", { type: "string", nullable: true })).toEqual({
        type: ["string", "null"]
      })
      expect(yield* bodyOf("3.0.3", { type: "string", enum: ["a"], nullable: true })).toEqual({
        type: ["string", "null"],
        enum: ["a", null]
      })
      expect(yield* bodyOf("3.0.3", { allOf: [{ type: "object" }], nullable: true })).toEqual({
        anyOf: [{ allOf: [{ type: "object" }] }, { type: "null" }]
      })
      expect(yield* bodyOf("3.0.3", { type: "string", nullable: false })).toEqual({
        type: "string"
      })
      expect(
        yield* bodyOf("3.0.3", {
          type: "object",
          properties: {
            n: {
              type: "integer",
              minimum: 1,
              exclusiveMinimum: true,
              maximum: 9,
              exclusiveMaximum: false
            }
          }
        })
      ).toEqual({
        type: "object",
        properties: { n: { type: "integer", exclusiveMinimum: 1, maximum: 9 } }
      })
      expect(yield* bodyOf("3.0.3", { type: "integer", maximum: 9, exclusiveMaximum: true })).toEqual({
        type: "integer",
        exclusiveMaximum: 9
      })
      expect(yield* bodyOf("3.0.3", { type: "integer", exclusiveMaximum: true })).toEqual({
        type: "integer"
      })
      // 3.1 writes these as JSON Schema does, so nothing is changed.
      expect(yield* bodyOf("3.1.0", { type: ["string", "null"], exclusiveMinimum: 1, nullable: true })).toEqual({
        type: ["string", "null"],
        exclusiveMinimum: 1,
        nullable: true
      })
    })
  )

  it.effect("keep what is data as it is, where a property is named as a keyword is", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({
          "/x": {
            post: {
              operationId: "x",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { items: { type: "string" }, properties: { type: "integer" } },
                      example: { items: { $ref: "#/not/a/reference" } },
                      default: { properties: 1 }
                    }
                  }
                }
              }
            }
          }
        })
      )

      expect(operationOf(imported, "x").definition.inputSchema.properties?.["body"]).toEqual({
        type: "object",
        properties: { items: { type: "string" }, properties: { type: "integer" } },
        example: { items: { $ref: "#/not/a/reference" } },
        default: { properties: 1 }
      })
    })
  )
})

describe("the body of a tool's request", () => {
  const bodyOf = (content: Schema.JsonObject) =>
    Effect.map(read(specOf({ "/x": { post: { operationId: "x", requestBody: { content } } } })), (imported) => imported)

  it.effect("is the first JSON media type, which may have parameters or be of a structured syntax", () =>
    Effect.gen(function* () {
      const imported = yield* bodyOf({
        "application/xml": { schema: { type: "string" } },
        "application/vnd.api+json": { schema: { type: "integer" } },
        "application/json; charset=utf-8": { schema: { type: "string" } }
      })

      expect(operationOf(imported, "x").definition.inputSchema.properties?.["body"]).toEqual({
        type: "integer"
      })
    })
  )

  it.effect("is any JSON when the document says nothing of it, and none when it has no content", () =>
    Effect.gen(function* () {
      const open = yield* bodyOf({ "application/json": {} })
      const none = yield* bodyOf({})

      expect(operationOf(open, "x").definition.inputSchema.properties?.["body"]).toEqual({})
      expect(operationOf(none, "x").request.body).toBeUndefined()
    })
  )
})

describe("an operation that is left out", () => {
  const skip = (operation: Schema.JsonObject, path = "/things/{id}", components?: Schema.JsonObject) =>
    skippedOf(
      specOf(
        { [path]: { post: Struct.assign({ operationId: "x" }, operation) } },
        components === undefined ? {} : { components }
      )
    )
  const pathId = { name: "id", in: "path", required: true, schema: { type: "string" } }

  it.effect("is told with the reason a body is not JSON", () =>
    Effect.gen(function* () {
      expect(
        yield* skip({
          parameters: [pathId],
          requestBody: { content: { "multipart/form-data": {}, "application/octet-stream": {} } }
        })
      ).toEqual([
        {
          operation: "POST /things/{id}",
          reason: "The body is multipart/form-data or application/octet-stream, and only JSON is supported"
        }
      ])
    })
  )

  it.effect("is told with the reason a parameter cannot be sent as the tool sends it", () =>
    Effect.gen(function* () {
      const reasons = []
      const parameters: ReadonlyArray<Schema.JsonObject> = [
        { name: "s", in: "query", style: "deepObject", schema: { type: "string" } },
        {
          name: "t",
          in: "query",
          explode: false,
          schema: { type: "array", items: { type: "string" } }
        },
        { name: "u", in: "query", schema: { type: "object" } },
        {
          name: "v",
          in: "query",
          schema: { type: "object", properties: { a: { type: "string" } } }
        },
        { name: "w", in: "query", schema: { type: "array", items: { type: "object" } } },
        {
          name: "y",
          in: "query",
          schema: { type: "array", items: { type: "array", items: { type: "string" } } }
        },
        { name: "z", in: "query", content: { "application/json": { schema: { type: "object" } } } },
        { name: "c", in: "cookie", required: true, schema: { type: "string" } },
        { name: "t", in: "body" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "array", items: { type: "string" } }
        }
      ]
      for (const parameter of parameters) {
        const skipped = yield* skip({ parameters: [parameter] }, "/things")
        reasons.push(skipped[0]?.reason)
      }

      expect(reasons).toEqual([
        "`s` is written in the style deepObject",
        "`t` is a list in one value",
        "`u` is not a string, a number, a boolean, or a list of them",
        "`v` is not a string, a number, a boolean, or a list of them",
        "`w` is not a string, a number, a boolean, or a list of them",
        "`y` is not a string, a number, a boolean, or a list of them",
        "`z` is described by its content",
        "`c` is a cookie",
        "`t` is in body",
        "`id` is not a string, a number, or a boolean"
      ])
    })
  )

  it.effect("is told with the reason the path and its parameters are not the same", () =>
    Effect.gen(function* () {
      const undeclared = yield* skip({ parameters: [] })
      const unused = yield* skip({
        parameters: [pathId, { name: "other", in: "path", required: true, schema: { type: "string" } }]
      })

      expect(undeclared[0]?.reason).toBe("The path has {id}, which no parameter describes")
      expect(unused[0]?.reason).toBe("`other` is a path parameter that the path does not have")
    })
  )

  it.effect("is told with the reason a schema refers to what the document does not hold", () =>
    Effect.gen(function* () {
      const body = (schema: Schema.JsonObject) => ({
        parameters: [pathId],
        requestBody: { content: { "application/json": { schema } } }
      })

      const external = yield* skip(body({ $ref: "other.json#/Pet" }))
      const dangling = yield* skip(body({ $ref: "#/components/schemas/Missing" }))
      const elsewhere = yield* skip(body({ $ref: "#/paths" }))

      expect(external[0]?.reason).toBe("The schema refers to other.json#/Pet, which is not a schema of the document")
      expect(dangling[0]?.reason).toBe(
        "The schema refers to #/components/schemas/Missing, which is not a schema of the document"
      )
      expect(elsewhere[0]?.reason).toContain("#/paths")
    })
  )

  it.effect("is told when a parameter or a path is not as OpenAPI says, or when its name is taken", () =>
    Effect.gen(function* () {
      const malformed = yield* skip({ parameters: [{ in: "query" }] }, "/things")
      const dangling = yield* skip({ parameters: [{ $ref: "#/components/parameters/Missing" }] }, "/things")
      const duplicated = yield* skippedOf(
        specOf({
          "/a": { get: { operationId: "same" } },
          "/b": { get: { operationId: "same" } },
          "/c": { $ref: "paths/c.json" }
        })
      )

      expect(malformed[0]?.reason).toBe("A parameter is not as OpenAPI says")
      expect(dangling[0]?.reason).toBe("A parameter is not as OpenAPI says")
      expect(duplicated).toEqual([
        { operation: "GET /b", reason: "It has the name of GET /a" },
        { operation: "/c", reason: "The path is not described in the document itself" }
      ])
    })
  )

  it.effect("does not keep the others from being tools", () =>
    Effect.gen(function* () {
      const imported = yield* read(
        specOf({
          "/a": { post: { operationId: "bad", requestBody: { content: { "text/csv": {} } } } },
          "/b": { get: { operationId: "good" } }
        })
      )

      expect(imported.operations.map((operation) => operation.definition.name)).toEqual(["good"])
      expect(imported.skipped.map((skipped) => skipped.operation)).toEqual(["POST /a"])
    })
  )
})

describe("a document that is not read", () => {
  const fail = (document: Schema.Json) => Effect.flip(read(document as Schema.JsonObject))

  it.effect("is not OpenAPI 3", () =>
    Effect.gen(function* () {
      const swagger = yield* fail({ swagger: "2.0", paths: {} })
      const text = yield* fail("openapi: 3.0.0")
      const unversioned = yield* fail({ paths: {} })
      const old = yield* fail({ openapi: "2.0", paths: {} })
      const paths = yield* fail({ openapi: "3.0.0", paths: [] })

      expect(swagger.message).toContain("Swagger 2.0")
      expect(text.message).toBe("The document is not an object")
      expect(unversioned.message).toBe("The document does not say that it is OpenAPI 3")
      expect(old.message).toBe("The document does not say that it is OpenAPI 3")
      expect(paths.message).toBe("The paths of the document are not an object")
    })
  )

  it.effect("has no tools when it has no paths", () =>
    Effect.gen(function* () {
      const imported = yield* read({ openapi: "3.1.0", info: { title: "x", version: "1" } })

      expect(imported).toEqual({ operations: [], servers: [], skipped: [] })
    })
  )
})

describe("the operations of a document, as an API is called", () => {
  const issues = specOf(
    {
      "/repos/{owner}/issues": {
        post: {
          operationId: "createIssue",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "labels", in: "query", schema: { type: "array", items: { type: "string" } } }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    milestone: { type: "integer", nullable: true }
                  },
                  required: ["title"]
                }
              }
            }
          }
        }
      }
    },
    { version: "3.0.3" }
  )

  const callThrough = (input: unknown) =>
    Effect.gen(function* () {
      const imported = yield* read(issues)
      const sent: Array<{
        readonly method: string
        readonly url: string
        readonly body: string | undefined
      }> = []
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          const body = (request.body as { readonly body?: Uint8Array }).body
          sent.push({
            method: request.method,
            url: url.toString(),
            body: body === undefined ? undefined : new TextDecoder().decode(body)
          })
          return HttpClientResponse.fromWeb(request, Response.json({ number: 7 }, { status: 201 }))
        })
      )
      const source = yield* Http.make({
        name: "github",
        baseUrl: "https://api.example.com",
        client,
        operations: imported.operations
      })
      const toolkit = yield* ToolSource.toolkit(source, yield* source.discover)
      const results = yield* toolkit.handle("createIssue", input).pipe(Effect.flatMap(Stream.runCollect))
      return { result: results[results.length - 1], sent }
    })

  it.effect("is made from the input the generated schema describes", () =>
    Effect.gen(function* () {
      const { result, sent } = yield* callThrough({
        owner: "octo cat",
        labels: ["bug", "ui"],
        body: { title: "Broken build", milestone: null }
      })

      expect(result?.isFailure).toBe(false)
      expect(result?.result).toEqual({ number: 7 })
      expect(sent).toEqual([
        {
          method: "POST",
          url: "https://api.example.com/repos/octo%20cat/issues?labels=bug&labels=ui",
          body: '{"title":"Broken build","milestone":null}'
        }
      ])
    })
  )

  it.effect("is refused before it is sent when the input is not what the generated schema describes", () =>
    Effect.gen(function* () {
      for (const input of [
        { labels: ["bug"], body: { title: "x" } },
        { owner: "o", body: {} },
        { owner: "o", body: { title: "x" }, stray: 1 },
        { owner: "o", body: { title: "x", milestone: "one" } }
      ]) {
        const { result, sent } = yield* callThrough(input)

        expect(result?.isFailure).toBe(true)
        expect(result?.result).toMatchObject({ code: "InvalidInputError" })
        expect(sent).toEqual([])
      }
    })
  )

  it.effect("has operations a catalog can store, as JSON", () =>
    Effect.gen(function* () {
      const imported = yield* read(issues)
      const json = Schema.toCodecJson(Schema.Array(Http.Operation))

      const stored = JSON.stringify(yield* Schema.encodeEffect(json)(imported.operations))

      expect(yield* Schema.decodeUnknownEffect(json)(JSON.parse(stored))).toEqual(imported.operations)
    })
  )
})
