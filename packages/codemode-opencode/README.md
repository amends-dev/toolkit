# @amends-dev/codemode-opencode

opencode's code mode as the runtime of [`@amends-dev/toolkit`](../toolkit)'s code mode.
Code mode presents a toolkit to a model as one tool, `execute`, that runs code the model writes, and
leaves running the code to a `CodeRuntime`. This runtime is
[`@opencode/codemode`](https://github.com/anomalyco/opencode/tree/dev/packages/codemode), an
interpreter of a subset of JavaScript that opencode wrote for the purpose: it implements the
language itself, so the code can reach nothing the interpreter does not give it, and no engine,
worker, or serialization stands between the code and the tools. The package depends on Effect,
the toolkit, and `@opencode/codemode`.

## Install

```sh
bun add @amends-dev/codemode-opencode @amends-dev/toolkit effect
```

`@opencode/codemode` names `effect` as a dependency rather than a peer, so a project on another
Effect 4.0 release gets a second copy of Effect under it, which its types then disagree with. Until
[the change that makes it a peer](https://github.com/anomalyco/opencode/compare/dev...saribmah:opencode:codemode-effect-peer)
is published, dedupe it in your manifest:

```json
{ "overrides": { "effect": "4.0.5" } }
```

## Quick start

`OpencodeCodeRuntime.make` gives the runtime, and `CodeMode.toolkit` presents a toolkit over it.

```ts
import { OpencodeCodeRuntime } from "@amends-dev/codemode-opencode"
import { Assembly, CodeMode } from "@amends-dev/toolkit"
import { Effect } from "effect"

declare const members: ReadonlyArray<Assembly.Member> // a workspace's sources, from the toolkit

const program = Effect.gen(function* () {
  const assembled = yield* Assembly.toolkit(members, () => "allow")
  // The model is shown `execute`, whose code calls the assembled tools on this runtime.
  return yield* CodeMode.toolkit(assembled, OpencodeCodeRuntime.make({ maxToolCalls: 50 }))
})
```

The toolkit's [code mode](../toolkit/README.md#code-mode) says what the model is shown and what a
run gives back; a [harness](https://github.com/amends-dev/harness/tree/main/packages/harness#host-tools)
session runs `execute` as it runs any host tool.

## What the code can do

The code is the body of an async function in the JavaScript the interpreter implements, which its
[support checklist](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/interpreter-support.md)
lists: the usual statements, functions, promises, and built-ins such as `JSON`, `Math`, `Date`,
`Map`, `Set`, `RegExp`, and `URL`. It has no modules, imports, timers, `process`, or file system,
and nothing of the host but what the runtime gives it:

- `tools.<name>(input)`, one function for each tool of the run, which returns a promise of the
  tool's answer as JSON. The input crosses as `JSON.stringify` would write it, and the answer as
  `JSON.parse` would read it; nothing is shared. The execution checks the input against the tool's
  parameters, and a failure reaches the code as an error whose message names the reason and what
  happened, `CallFailedError: No such repository`, which the code can catch.
- `console.log`, whose lines come back as the run's logs.
- `search({ query })`, which finds the run's tools by name, counted as a call of a tool.

What the code returns comes back as JSON, `null` when it returns nothing, with the logs. A
rejection the code did not await, and work it left running when it returned, are interrupted and
come back as warnings after the logs. A run fails with the toolkit's `CodeError` when the code
throws, cannot be parsed or uses syntax the interpreter does not run, calls a tool the run does not
have, or makes more calls than `maxToolCalls` allows, saying where in the code when the interpreter
knows. The toolkit's own `timeout` interrupts a run, a busy loop included, since the interpreter
yields between its steps; one step is bounded in what it may build, so no built-in runs away.

## Development

Run the package's tests with `bun run test packages/codemode-opencode`: the runtime over fake
tools, and `execute` as `CodeMode.toolkit` presents it.
`bun run dist check packages/codemode-opencode` builds the package as npm gets it and checks it as
a consumer. In this repository, the root manifest's
`overrides` keeps `@opencode/codemode` on the catalog's Effect.
