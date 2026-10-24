# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue or pull request for it.

Say what is affected, such as a package and its version, how to reproduce it, and what an attacker
could do with it. We will confirm we received it, keep you told as we investigate and fix it, and
publish a security advisory once a fix is released, crediting you if you would like.

## Supported versions

These packages are in early development. Fixes go into `main` and the next release of each
package; earlier releases do not receive them.

## Scope

Reports are welcome for every package in this repository: above all, a way for a model to see a
credential or an address of a system, to send a request that the source's tools do not describe, or
for code in code mode to reach anything but the tools it is given.

Some behavior is by design, and is not a vulnerability:

- **A source sends what its client is given.** The credentials a source's requests carry are those
  of the HTTP client the caller builds it over; the toolkit neither holds nor checks them.
- **What a tool may do is the host's decision.** `Assembly` offers, asks approval for, or hides each
  tool as the policy the host gives it says.
- **Code mode's tests run code in the same process.** The runtime the toolkit's tests use isolates
  nothing and must not be used outside them; `@amends-dev/codemode-opencode` is a runtime that
  isolates the code.

A vulnerability in Effect, an MCP server, an API, opencode's interpreter, or another dependency
belongs with that project. Tell us too when it affects these packages in a way of its own.
