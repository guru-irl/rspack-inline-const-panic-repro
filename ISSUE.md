# [Bug]: `should have module id` panic with module concatenation + inline-const (regression in 2.1.0)

## System Info

- **rspack**: first broken **2.1.0**, still broken **2.1.2**; last good **2.0.1**
- **optimization**: production defaults — `usedExports`, `sideEffects`, `concatenateModules`,
  `innerGraph`, `inlineExports`, and `experiments.pureFunctions` all enabled (all default
  to `true`/production)
- Reproduces on Linux x64; not platform specific

## Summary

A production build panics during module-concatenation code generation:

```
thread 'tokio-*' panicked at .../crates/rspack_core/src/concatenated_module.rs:
should have module id
```

A **`sideEffects: false` package that exports a plain `function makeStyles`** (the real
trigger is [`@griffel/react`](https://github.com/microsoft/griffel), consumed by
Fluent UI) makes rspack attach an **impure deferred pure-check** to short numeric
`const` imports that feed a `makeStyles(...)` call. In 2.1 those consts are **inlined to
zero chunks** by inline-const, but the concatenation pass still marks the (cloned) import
connection **active** and emits an external `__webpack_require__(<module id>)` to a module
that no longer lives in any chunk → `get_module_id(...).expect("should have module id")`
→ panic.

A self-contained reproduction is in this repository (`npm install && npm run build`).

## Reproduction

```bash
npm install
npm run build          # @rspack/core 2.1.2 -> PANIC: "should have module id"

# prove it is a 2.1 regression:
npm install @rspack/core@2.0.1 @rspack/cli@2.0.1
npm run build          # -> compiles successfully
```

Graph shape:

```
src/app.ts
  ├─ import("components/AiHub")           (async chunk)
  │     └─ AiHub() → Inner()              (Inner is concatenated INTO AiHub)
  │            └─ const useInnerStyles = makeStyles({ maxWidth: SEARCH_BOX_MAX_WIDTH, ... })
  └─ import("components/HomePage.styles") (async chunk, second consumer of the consts)

constants/stylingConstants.ts
        export const SEARCH_BOX_MAX_WIDTH = 731;   // short numeric consts,
        export const SIDE_PANE_WIDTH      = 400;   // inline-const eligible
        ...

styling  (package.json: "sideEffects": false)      // mirrors @griffel/react
        makeStyles.ts  -> plain `function makeStyles(...)`  (NO /*#__NO_SIDE_EFFECTS__*/)
                          imports a side-effectful sibling module
```

## Root cause

Three 2.1 behaviors combine. Each is individually correct; together they are inconsistent.

### 1. inline-const drops the const module to zero chunks

`optimization.inlineExports` (production default, new in 2.1) inlines the short numeric
`const`s at every use site. Nothing references `stylingConstants` at runtime, so the
side-effect-free module is dropped from every chunk (`n_chunks == 0`).

> Note: this requires the loader to emit real `const` (e.g. swc-loader `jsc.target:
> "esnext"`). A downleveled target rewrites `const`→`var`, disables inline-const, and
> hides the bug.

### 2. A `sideEffects:false` package produces an *impure* deferred pure-check

Because the styling package is `sideEffects: false`, the consumer marks its imported
`makeStyles` as a **side-effects-free deferred callee**, which attaches a deferred
pure-check to each `const` import that feeds a `makeStyles(...)` call.

The impurity test then disagrees with itself:

`deferred_pure_check_is_impure`
(`crates/rspack_plugin_javascript/src/parser_plugin/inner_graph/mod.rs`) resolves the
target export and calls `module_has_side_effects_free_export`, which reads the target
module's **per-export** `build_info().side_effects_free` set. **Package-level
`sideEffects: false` never populates that per-export set** (only
`/*#__NO_SIDE_EFFECTS__*/` annotations and numeric consts do). For a plain
`function makeStyles` in a `sideEffects:false` package the set is `None`, so the function
falls through to its final `return true` → **impure**.

This is exactly `@griffel/react`'s shape: `makeStyles.esm.js` is a plain
`function makeStyles(...)` (no `/*#__NO_SIDE_EFFECTS__*/`), re-exported through the
package barrel, in a `"sideEffects": false` package.

### 3. Concatenation marks the inlined connection active

`Inner` (which owns the `const … = makeStyles(...)` statement) is concatenated into the
async root `AiHub`. Concatenation **clones** `Inner`'s const import dependency. In the
concatenated context, `connection_active_for_esm_import_specifier`
(`crates/rspack_plugin_javascript/src/dependency/esm/esm_import_specifier_dependency.rs`)
short-circuits on the deferred pure-check **before** it checks whether the export was
inlined:

```rust
if let Some(used_by_exports) = dependency.used_by_exports.as_ref() {
  if has_impure_deferred_pure_checks(module_graph, exports_info_artifact, used_by_exports) {
    return true;                      // <-- reported active, ignoring inlining
  }
  if used_by_exports.is_false_without_deferred_pure_checks() { return false; }
}
let active_by_used_exports = /* ... */;
active_by_used_exports
  && connection_active_inline_value_for_esm_import_specifier(/* ... */) // inline check LAST
```

So the connection is reported active even though the value was inlined. Concatenation
(`get_imports` / `get_concatenated_imports`) then treats it as a live external import and
emits `__webpack_require__(<module id>)` for a module inlining already removed from every
chunk → the module has no id → `expect("should have module id")` → **panic**.

### Why the known workarounds avoid it

- `concatenateModules: false` — no external `require()` is emitted.
- `usedExports: false` — no inline-const, so the module is kept in a chunk.
- A scoped `sideEffects` annotation on the constants module — changes module inclusion so
  the const is not dropped to zero chunks.

## Suggested fix

Evaluate the **inline-value check first** in `connection_active_for_esm_import_specifier`
and return `false` (inactive) when the referenced export is inlined, **before** the
`used_by_exports` / `has_impure_deferred_pure_checks` short-circuit. When the value is
inlined, the connection needs no runtime module reference and must be inactive, regardless
of deferred pure-checks. Side effects are tracked by a separate side-effect import
dependency, not the specifier dependency, so they are unaffected. Only the
`inlined && has_impure_deferred_pure_checks` case changes (active → inactive); every other
case is unchanged.

Branch: https://github.com/guru-irl/rspack/tree/fix/inline-const-concat-active-panic

## Verification

- The reproduction in this repo: panics on 2.1.0–2.1.2, builds cleanly on 2.0.1, and
  builds cleanly with the patched binding.
- Reproduced independently on two large production apps; both build cleanly with the
  patched binding and the `sideEffects` workaround removed.
- rspack test suite against the patched release binding:
  - `TreeShaking.test.js` — **84 passed**
  - `configCases/inline-const/*` — **24 passed**
  - `configCases/concatenate-modules/*` — **48 passed**
