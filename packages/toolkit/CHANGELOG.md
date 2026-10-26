# @amends-dev/toolkit

## 0.2.2

### Patch Changes

- [#1](https://github.com/amends-dev/toolkit/pull/1) [`d001baa`](https://github.com/amends-dev/toolkit/commit/d001baae8267a38f49aff34ef963c021645af35a) Thanks [@saribmah](https://github.com/saribmah)! - Moved to its own repository, [amends-dev/toolkit](https://github.com/amends-dev/toolkit), which its links on npm and its provenance now name.

## 0.2.1

### Patch Changes

- [#44](https://github.com/amends-dev/amends/pull/44) [`6670c03`](https://github.com/amends-dev/amends/commit/6670c0357e9010acec35858fbdc0595a2b62e6ae) Thanks [@saribmah](https://github.com/saribmah)! - `Presentation.merge` and `Presentation.restrict` keep the types of the tools they are given, as Effect's `Toolkit.merge` does, so a toolkit from `CodeMode.toolkit` or `merge` asks for the services its tools need rather than `any`, and a program that runs a turn with one has no requirements left to `BunRuntime.runMain`.
