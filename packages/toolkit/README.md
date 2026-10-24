# @amends-dev/toolkit

Tools for agents from wherever they come: an MCP server, an HTTP API with an OpenAPI document, or
operations written by hand. Every kind of source has one shape, `ToolSource`, and `Assembly` builds
from sources the Effect AI toolkit that a model, or a
[harness](https://github.com/amends-dev/harness) session, is given as its `toolkit`, under a policy
that says what each tool may do. `ToolSearch` and `CodeMode` present a large set of tools as a few.
The package depends only on Effect.

No credential enters the package. A source is built over an HTTP client that the caller has already
given the credentials its system asks for, so what a source sends is never decided by the model, and
what authorizes it is never seen here.

## Install

```sh
bun add @amends-dev/toolkit effect
```

In [amends](https://github.com/amends-dev/amends), the
[connection](https://github.com/amends-dev/amends/tree/main/packages/connection#readme) package's
tool integrations make MCP and HTTP sources for the connections a workspace makes; agents do not
take toolkits yet.

## Quick start

A source is made over a client that carries its credentials. Its `discover` lists the tools, which a
host stores as its catalog, and `Assembly.toolkit` builds from the catalog the toolkit of a turn,
deciding for each tool whether the model may call it, must have the call approved, or is not shown
it. The toolkit is Effect AI's, so a `LanguageModel` calls its tools, and so does a harness session,
given it as its `toolkit`.

```ts
import { Assembly, Mcp } from "@amends-dev/toolkit"
import { Config, Effect, Redacted } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

const program = Effect.gen(function* () {
  // The client carries the server's credentials; the source never sees them.
  const token = yield* Config.Redacted("MCP_TOKEN")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(token)))
  )
  const tasks = yield* Mcp.http({ name: "tasks", url: "https://mcp.example.com/mcp", client })

  // The catalog: what the source has now, which a host stores and refreshes.
  const definitions = yield* tasks.discover

  // The toolkit of a turn: the tools that read, and none that write, as this host decides.
  const toolkit = yield* Assembly.toolkit([{ source: tasks, definitions }], (_source, definition) =>
    definition.annotations.readOnly === true ? "allow" : "block"
  )

  // The model calls `tasks__list_tasks`, and reads a call that failed as a result.
  const response = yield* LanguageModel.generateText({ prompt: "What is due this week?", toolkit })
  return response.text
}).pipe(Effect.provide(FetchHttpClient.layer))
```

A [harness](https://github.com/amends-dev/harness/tree/main/packages/harness#host-tools) session
takes the same `toolkit`: it runs the tools on the host as the agent calls them, whichever agent it
is, and asks a person about a tool the policy set to `approve` before it runs.

## Definitions

`ToolDefinition.ToolDefinition` is a tool as data, in a form a catalog can store as JSON
(`Schema.toCodecJson`) and a source can report before anything runs the tool: a `name`, a
`description`, its parameters as the JSON Schema with an object root that an agent reads
(`inputSchema`), and `annotations`. The annotations are `title`, `readOnly`, `destructive`,
`idempotent`, and `openWorld`, named as Effect AI's tool annotations are, and left out when the
source did not say, so that Effect AI's default for a hint applies. They are a source's claims and
not guarantees, so a decision about what a tool may do must not rest on them alone. A definition has
no output schema, which MCP and OpenAPI report: what a tool answers is JSON the model reads.

## Sources

A `ToolSource.ToolSource` has a `name`, `discover`, which asks the source which tools it has now,
and `call`, which runs one tool with an input object and returns JSON. `ToolSource.toolkit` builds
the toolkit for a source's definitions, one Effect AI dynamic tool for each, whose names must be
distinct. Building contacts nothing: the definitions come from the caller, who has them from a
catalog, and the source is reached only when the model calls a tool. `discover` is for the catalog,
which asks a source what it has when it refreshes.

Effect AI does not check the parameters of a dynamic tool, so a call does, before the source sees
the input. The input must be an object that matches the tool's JSON Schema, and one that the schema
closes may have no property it does not name. A `pattern` or a `format` is not checked, since the
source checks it too and a pattern from a source is not run here, and a schema that Effect cannot
turn into a check is held only to being an object. The source gets the input as the model gave it. A
model API that has a strict schema mode, as OpenAI's does, is asked not to use it for a source's
tools, since the parameters are the source's and may leave a property optional, which strict mode
refuses.

Whatever happens to a call is a result the model reads, so that the turn goes on and the model can
try something else. A failure arrives as `Failure`, `{ code, message, retryable }`, with `isFailure`
set. A defect in a source is logged and reported, and the model reads that the source failed; only
interrupting the call ends it in any other way. A `needsApproval` function marks the tools that a
harness session asks about before it runs them.

## Errors

`ToolSourceError` names the source and holds a `reason`: `AuthenticationError`, `NotFoundError`,
`InvalidInputError`, `CallFailedError`, which is a tool that ran and said it failed, or answered
more than a tool can return, `UnavailableError`, the only one worth trying again, though it does not
say when, as a rate limit does with `Retry-After`, `InvalidResponseError`, `UnsupportedError`, and
`UnknownError`. A host recovers from one with
`Effect.catchReason("ToolSourceError", "AuthenticationError", ...)`, to ask for a connection again.
What the model reads of a failure is the reason's `modelMessage`: the description of an
`InvalidInputError` or a `CallFailedError`, which is written for it, and only the default message of
any other reason, whose description may name an address or another internal.

## MCP

`Mcp.http({ name, url, client })` is the source of an MCP server over Streamable HTTP. It asks for
the tools with `tools/list` and runs them with `tools/call`, and does nothing else of MCP: it reads
no resources or prompts, and answers no request a server makes of its client.

`Mcp` is the source, which lists the tools and runs them over a transport, with two helpers under
`src/internal`. `mcpTransport.ts` speaks to the server, and knows nothing of tools: it settles how
the server is spoken to and sends a request. `mcpHeaders.ts` holds the rules for the headers that
mirror a tool's parameters.

The transport speaks the stateless protocol of 2026-07-28 to a server that does, which it finds out
with `server/discover` when it first needs the server. A server that does not answer that, unless it
refuses the source or cannot be reached, is spoken to with a session, begun with `initialize`, in
the version it answers with of 2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05. When a server
ends the session, the source begins another once.

A tool's result is its structured content when it has some, and else its content blocks as the
server wrote them. A tool that reports `isError` is a failed call, with the text it said, which the
model reads. A tool that asks for input first, as `input_required`, is `UnsupportedError`. The
definitions carry the hints a server gives.

A server of the stateless protocol may mark parameters of a tool with `x-mcp-header`, so that a load
balancer can route on them. The source sends each such parameter that a call gives as a header
`Mcp-Param-<name>` as well, and the server refuses a call that lacks one. A value that a header
cannot hold as it is, such as one with a character that is not printable ASCII or that ends in a
space, is sent as its UTF-8 in base64 between `=?base64?` and `?=`, so that no value adds a header,
and so is the name of a tool, in `Mcp-Name`. The source knows which parameters a tool marks from the
last time it listed the tools. A source that has not listed them sends the call without the headers,
and when the server refuses the call with `-32020`, it lists the tools and sends the call once more,
if the headers they ask for are other than those it sent, which is also how it learns of a server
that has changed its tools. A tool whose marks the protocol does not allow, such as two of one name
or one on a parameter that is an object, is left out of `discover`, with a warning logged. A mark on
a number is allowed, though the protocol says otherwise. Only the parameters that `properties` lead
to are marks: one under `items`, `anyOf`, `$defs`, or the like makes the tool unusable. A server
with sessions has no such headers, and its tools are listed as they are.

A request that the server does not answer within `timeout`, a minute by default, fails as
`UnavailableError`, which a call of a tool counts in. Not done: a session is not ended when the
source is no longer used, and stdio servers are not reached, though `effect/process` and
`effect/encoding` hold what a source would need.

## HTTP and OpenAPI

`Http.Operation` is a tool that is an HTTP request: its `definition`, and a `RequestTemplate` with
the method, the path, where each property of the input goes (a segment of the path, a query
parameter, or a header), and the property that holds a JSON body. It is data, so a catalog stores
it. `Http.make` makes a source of operations that sends their requests to one base URL.

What the model gives fills the places the operation has for it and decides nothing else. A value in
the path is encoded and may not be empty, `.`, or `..`, which URL normalization would turn into
another operation. A value is a string, a number, or a boolean. A query may take a list of them,
sent as a key for each value, and a header a list joined by commas, and a header value holds no
character that could add a header. The client's own headers, which carry its credentials, come last.
A success is the body as JSON, as text, or `null` without one. A 401 or 403 is an
`AuthenticationError`, a 408, 429 or 5xx an `UnavailableError` whose body the model does not read,
and any other 4xx a `CallFailedError` with the API's own words, cut to 500 characters.

`OpenApi.readOperations` reads the operations of an OpenAPI 3 document, which is JSON already read
(Effect's `encoding/Yaml` reads YAML), and nothing else: it fetches no reference, and uses no
address in it besides listing them as `servers`, since where requests go is the host's to say. Its
tools take a property for each parameter, named as the parameter is in the characters agents accept,
with the place put before the name when two would share one or one is `body`, and a property `body`.
The input is one schema that stands alone, with the schemas of the document that it refers to under
`$defs`. A schema of OpenAPI 3.0 is made as 3.1 has it, since a validator that does not know
`nullable` would refuse a `null`. The hints are what HTTP says of a method: a safe method is
`readOnly`, POST and PATCH are not `idempotent`, and DELETE is `destructive`. Nothing is guessed
beyond that.

An operation that cannot be a tool is left out with the reason, in `skipped`, so that a host can
show what it lost, as for a body that is not JSON, a parameter written in a style other than the
default or that is an object, a cookie it needs, a path that its parameters do not match, a
reference to anything but a schema of the document, or a name another operation has. A call that
takes longer than `timeout`, 30 seconds by default, fails as `UnavailableError`, and an answer longer
than `maxAnswerLength`, 200,000 characters by default, as `CallFailedError`, telling the model to ask
for less. A default `User-Agent`, which some APIs ask for, is the client's to set.

## Assembly

`Assembly.toolkit(members, decide, options?)` makes the one toolkit of a turn from the sources a
workspace has, each with the definitions of its tools that the workspace holds. `decide` says, for a
source's name and a definition, `allow`, `approve`, or `block` (the `Decision` schema, so that a
policy can be stored). A blocked tool is left out, and an approved one is marked as needing
approval. Which is right is the host's to say from what it has stored, and there is no default.

A model knows a tool by its source's name and its own, `github__create_issue`, in the characters and
length that model APIs accept: any other character becomes `_`, and a name beyond 64 characters is
cut and ends with a fingerprint of the whole, so that long names that differ only after the cut stay
apart, and a name is the same whenever it is made. A call reaches the source that owns the tool, by
the name that source knows it by. Tools that would still have one name fail the assembly with
`NameClash`, which holds every clash. Building contacts none of the sources.

An agent that adds to the tool names it is given has fewer than 64 characters to spare. The
`maxNameLength` option, at least 16, cuts names to what the agent takes, as an agent's
`maxToolNameLength` says: `Assembly.toolkit(members, decide, { maxNameLength })`.

## Search

`ToolSearch.toolkit(presented, options?)` presents a toolkit to a model as two tools, in place of
one for each, which suits a large set of tools, or one that changes from turn to turn. It takes the
toolkit of an assembly, or any other, and gives another.

```ts
const assembled = yield * Assembly.toolkit(members, decide)
const toolkit = yield * ToolSearch.toolkit(assembled)
```

- `tool_search({ query, limit? })` finds tools by what they do, and returns for each its `name`,
  `description`, and `inputSchema`, with `matched`, how many tools match, and `available`, how many
  there are, so that a model knows when a search cut its matches short. A word of the query scores
  for a word of a tool's name that is the same, or that it begins, and for one of its description,
  the name counting most; a name is read in words whether it is `create_issue`, `create-issue`, or
  `createIssue`. A tool that scores nothing does not match, and a query with no words lists the
  tools in order. A search returns five tools unless it asks for more, up to twenty, or the `limit`
  option changes the five. It is a plain match on words, not a search by meaning.
- `tool_call({ name, input })` runs the tool of that name, which the presented toolkit does as it
  does when a model calls it directly: it checks the input against the tool's parameters, runs the
  handler, and gives the tool's result. A failure is a result the model reads, as `Failure`, and a
  name that is no tool is `NotFoundError`. A tool that was blocked is not in the presented toolkit,
  so it can be neither found nor called.

A tool that needs approval needs it when the model calls it through `tool_call`: the approval is the
tool's own, as its `needsApproval` says, asked about the input the model gave, so a session asks
about the call as it asks about any other, and the model cannot reach a tool that needs approval by
another way. `tool_search` runs nothing and needs none. Neither tool is sent in a model API's strict schema mode, which allows no optional
`limit` and no input whose shape depends on the tool named.

What the model is shown is the same two tools however many there are, and what it reads of the
others is what it searched for. The names of the presented tools are only text the model reads and
writes, so Search is also a way past the length of tool names that an agent leaves. The host chooses
between this and showing every tool, with no default: showing every tool costs the tokens of all of
them on every turn, and Search costs a search for the model to make first.

## Code mode

`CodeMode.toolkit(presented, runtime, options?)` presents a toolkit as one tool, `execute`, that
runs code the model writes, which calls the tools of the presented toolkit as functions. A model
does in one run what takes it many calls otherwise: it calls a tool, reads the result in code,
filters it or goes on with the next call, and only what the code returns comes back to it.

```ts
const assembled = yield * Assembly.toolkit(members, decide)
const toolkit = yield * CodeMode.toolkit(assembled, runtime)
```

- `execute({ code })` takes the body of an async function. The code calls a tool as
  `await tools.<name>(input)`, notes what it wants to see with `console.log`, and `return`s JSON.
  What the model reads of `execute` declares the tools as TypeScript, written from their JSON
  Schemas: the shape of an input, the properties it requires, the values an enum allows, and the
  descriptions as comments, with `unknown` for what a type cannot say, such as a cyclic schema or
  one nested more than six levels. A tool is called as it is when a model calls it directly: its
  input is checked, and a failure is what it says, which the code reads as an error it can catch.
- The run gives back `{ result, logs }`, `result` being `null` when the code returns nothing. It
  fails as a result the model reads, with `CodeError`, and what the code logged before, when the
  code throws; with `Timeout` when it runs longer than `timeout`, a minute by default, which its
  tool calls count in; and with `ResultTooLarge` when its JSON is longer than `maxResultLength`,
  50,000 characters by default, so that code that returns too much is told to return less.
- A tool that needs approval cannot be called from code, since a session cannot ask a person in the
  middle of a run. It is a tool of its own beside `execute`, so that a session asks about its calls
  as it asks about any other, and a tool whose `needsApproval` is a function of the call is treated
  as one that needs it. `execute` itself needs none. Asking about a whole run is not done.

Running the code is a `CodeRuntime`'s, an interface this package does not implement: `run` takes the
code, the names of the tools it may call, and `call`, which calls one, and gives the result and
logs, or fails with `CodeError`. A runtime has to run the code in an isolate that can reach nothing
but those tools, gives it `tools` and `console`, and stops when interrupted. It is an adapter that
has such an isolate that implements it:
[`@amends-dev/codemode-opencode`](../codemode-opencode) runs the code on opencode's
interpreter. The tests of this module use a runtime that runs the code in the same process, which
isolates nothing and must not be used for anything else.

## Presentations

Search and Code mode share `Presentation`: each takes the toolkit an assembly gave, which is the
model's to use, and gives another, through which the model reaches the first. `Presentation.call`
runs a tool of the first and gives its result as JSON, or fails as a `Failure`; a tool that gives
nothing gives `null`. `restrict` and `merge` make a toolkit of some tools of one, or of both of two,
which run as they do in the toolkit they come from. Showing every tool is the third way, with
nothing to present.

## What the host does

The host builds the HTTP client and so owns every credential, decides what each tool may do, stores
definitions and operations and refreshes them with `discover` or `readOperations`, and passes the
assembled toolkit to a session, as it is or presented with Search. How a session's tools reach an
agent, natively or through MCP or code mode, is not decided here.

## Conformance

`@amends-dev/toolkit/conformance` holds the suites every kind of tool source runs against itself, so
that code written against `ToolSource` works the same on each. A source's tests call `run` with a
`Fixture`, which makes the source for one test over a system that serves three tools: `echo`, which
answers with the text it is given, `failing`, which reports that it failed, and `blocking`, which
does not answer. The fixture makes the source over the system as it is for the suite that asks:
`working`, `unauthorized`, `unavailable`, or `unreachable`. The suites need `@effect/vitest`, an
optional peer dependency that only a source's tests install, and run on the live clock.

They require of a source that it:

- lists definitions that a catalog can store as JSON, under distinct names, and the same each time;
- runs a tool by the name it lists, returns JSON, and answers calls that run together each with its
  own answer;
- fails a tool that reports its failure as `CallFailedError`, and a tool it does not have as an
  error of the source and not a defect, with every failure a `ToolSourceError` that names the
  source, and runs tools again after one;
- stops a call that is interrupted;
- fails with `AuthenticationError`, which is not retryable, when its credentials are refused, and
  with `UnavailableError`, which is, when the system says it is down or cannot be reached, as a
  request for the tools does too if the source asks the system for them;
- tells a model no credential and no address of the system;
- is read by a model through `ToolSource.toolkit` as results, with the failures above as results and
  an input its parameters do not allow refused, and is assembled by `Assembly.toolkit`.

## Development

```sh
bun run test packages/toolkit
```

`bun run dist check packages/toolkit` builds the package as npm gets it and checks it as a consumer.

`test/tool-source.test.ts`, `test/tool-source-error.test.ts`, `test/tool-definition.test.ts`,
`test/assembly.test.ts`, `test/tool-search.test.ts`, `test/presentation.test.ts`, and
`test/code/code-mode.test.ts` run over fake sources and toolkits, and
`test/code/declarations.test.ts` holds what the TypeScript declarations say of each kind of schema.
`test/conformance.test.ts` runs the conformance suites for four subjects: the MCP source over Effect
AI's own server speaking the stateless protocol and one speaking with sessions, the HTTP source over
operations written by hand, and the HTTP source over the operations of an OpenAPI document, the last
two against a `Bun.serve` server that `test/conformance-servers.ts` starts for each test.
`test/mcp/source.test.ts` runs Effect AI's MCP server in the process behind a `fetch` that records
each request; `test/mcp/wire.test.ts` answers from a script what a server never sends, such as event
streams with other messages in them, pagination, and each status and error code; and
`test/mcp/headers.test.ts` holds the rules for the headers that mirror parameters.
`test/http.test.ts` records the requests of a scripted client and sends a few over the wire, and
`test/openapi.test.ts` reads documents written in each test and takes one through the toolkit to a
request. These tests need `Request`, `Response`, and `Bun`, which shared packages do not have, so
the root `tsconfig.json` checks them.

## Inspiration

The catalog a host stores and refreshes, and the policy kept apart from which tools a model is
shown, follow [executor](https://github.com/UsefulSoftwareCo/executor). Search and code mode follow
Anthropic's writing on [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
and the AI SDK's tool search and code mode.
