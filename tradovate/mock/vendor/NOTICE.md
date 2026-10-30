# Vendored from Tradovate

`tools/`, `builtin/` and `examples/` are copied unchanged from
[tradovate/custom-indicators](https://github.com/tradovate/custom-indicators), commit
`54f7ff5`. Its package.json gives the licence as ISC, author Tradovate Technologies.

- `tools/` are the helper modules an indicator gets from `require("./tools/...")`.
  The mock runs the real ones, so an EMA behaves as it does on the platform.
- `builtin/` and `examples/` are the conformance suite: test/mock.test.mjs runs every
  one of them through the mock.

`./tools/graphics` is not in that repo. tradovate/mock/runtime.mjs builds it from the
repo's typescript/graphics/ definitions.
