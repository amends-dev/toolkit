# toolkit

Tools for agents from wherever they come, for [Effect](https://effect.website): an MCP server, an
HTTP API with an OpenAPI document, or operations written by hand, in one shape. A host assembles
them into the Effect AI toolkit a model calls, deciding what each tool may do, and can present many
tools as few through search or code mode.

| Package                                                       | What it is                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`@amends-dev/toolkit`](packages/toolkit)                     | Tool sources, assembly, search, code mode, and conformance suites |
| [`@amends-dev/codemode-opencode`](packages/codemode-opencode) | opencode's interpreter as the runtime of the toolkit's code mode  |

```sh
bun add @amends-dev/toolkit effect
```

The [toolkit's guide](packages/toolkit/README.md) shows a source assembled into the toolkit a
`LanguageModel` calls, and its [conformance suites](packages/toolkit/README.md#conformance) for a
new kind of source. A [`@amends-dev/harness`](https://github.com/amends-dev/harness) session takes
the same toolkit.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks every change passes, and
releases. Report a vulnerability as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
