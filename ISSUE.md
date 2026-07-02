# [Bug]: `should have module id` panic with scope hoisting + inline-const (regression in 2.1.0)

## System Info

```
  System:
    OS: Linux Ubuntu 24.04.1 LTS
    CPU: (24) x64 AMD Ryzen 9 3900X 12-Core Processor
  Binaries:
    Node: 22.18.0
    npm: 10.9.3
  npmPackages:
    @rspack/cli: 2.1.2
    @rspack/core: 2.1.2
```

Regression range: broke in **2.1.0**, still broken in **2.1.2**, last good version is **2.0.1**.

## Reproduction

Minimal repro (no framework, ~10 tiny files): https://github.com/guru-irl/rspack-inline-const-panic-repro

```bash
git clone https://github.com/guru-irl/rspack-inline-const-panic-repro
cd rspack-inline-const-panic-repro
npm install
npm run build     # panics: "should have module id"

# confirm it's a 2.1 regression:
npm install @rspack/core@2.0.1 @rspack/cli@2.0.1
npm run build     # builds fine
```

## What happens

A production build panics during scope-hoisting codegen:

```
thread 'tokio-*' panicked at crates/rspack_core/src/concatenated_module.rs:
should have module id
```

I originally hit this on a couple of large apps that use Fluent UI, and the module that
panics is always a tiny `sideEffects: false` file that only exports numeric constants like
`export const SEARCH_BOX_MAX_WIDTH = 731`. After a lot of digging it turned out the trigger
is the combination of `@griffel/react`'s `makeStyles` (which Fluent UI re-exports) and the
new inline-const optimization. The repo above reproduces it with a ~15-line stand-in for
griffel so you don't need Fluent UI to see it.

## Why it happens

Three things have to line up. Individually they're all fine; together they contradict each
other.

**1. inline-const removes the constants module entirely.** In 2.1 the short numeric consts
get inlined into every consumer (`optimization.inlineExports`, on by default in
production). Once that happens nothing imports the constants module at runtime, so it's
dropped from every chunk and ends up with `n_chunks == 0`.

(This only kicks in if the loader actually emits `const` — with swc-loader you need
`jsc.target: "esnext"`. A downleveled target turns `const` into `var`, inline-const bails,
and the bug hides. That cost me a while to figure out.)

**2. A `sideEffects: false` package attaches an *impure* deferred pure-check to the const
imports.** Because griffel is `sideEffects: false`, the consumer treats `makeStyles` as a
side-effects-free deferred callee, and each const that feeds a `makeStyles({...})` call
picks up a deferred pure-check.

The impurity check is where it goes wrong. `deferred_pure_check_is_impure` in
`crates/rspack_plugin_javascript/src/parser_plugin/inner_graph/mod.rs` resolves the target
export and asks `module_has_side_effects_free_export`, which reads the target module's
*per-export* `build_info().side_effects_free` set. That set is only ever populated by
`/*#__NO_SIDE_EFFECTS__*/` annotations or numeric consts — package-level
`"sideEffects": false` doesn't touch it. So for a plain `function makeStyles` in a
`sideEffects: false` package the lookup returns `None`, the function falls through to its
final `return true`, and the check comes back **impure**.

That's exactly griffel's shape: `makeStyles.esm.js` is a plain `function makeStyles(...)`
with no `/*#__NO_SIDE_EFFECTS__*/`, re-exported through the package barrel, in a
`"sideEffects": false` package.

**3. Scope hoisting then trusts that stale "active" answer.** The module that owns the
`const x = makeStyles(...)` call gets concatenated into its only importer, which clones the
const import dependency. In the concatenated context,
`connection_active_for_esm_import_specifier`
(`crates/rspack_plugin_javascript/src/dependency/esm/esm_import_specifier_dependency.rs`)
checks the deferred pure-check *before* it checks whether the export was inlined:

```rust
if let Some(used_by_exports) = dependency.used_by_exports.as_ref() {
  if has_impure_deferred_pure_checks(module_graph, exports_info_artifact, used_by_exports) {
    return true;                      // reports active, never looks at inlining
  }
  if used_by_exports.is_false_without_deferred_pure_checks() { return false; }
}
let active_by_used_exports = /* ... */;
active_by_used_exports
  && connection_active_inline_value_for_esm_import_specifier(/* ... */) // inline check is last
```

So the connection is reported active even though the value was already inlined.
Concatenation then emits an external `__webpack_require__(<module id>)` for a module that
inline-const removed from every chunk. There's no id → `expect("should have module id")` →
panic.

This also lines up with the known workarounds — each one breaks one of the three legs:
`concatenateModules: false` (no external require emitted), `usedExports: false` (no
inline-const, module stays in a chunk), or a scoped `sideEffects` entry on the constants
file (module isn't dropped).

## Suggested fix

Do the inline-value check first. If the referenced export was inlined, the connection
doesn't need a runtime module reference and should be inactive regardless of the deferred
pure-checks — so return `false` before the `has_impure_deferred_pure_checks` short-circuit.
Side effects ride on a separate side-effect import dependency, not the specifier
dependency, so nothing about side-effect ordering changes. Only the
`inlined && impure-deferred-check` case flips (active → inactive); everything else stays
the same.

I have a patch here: https://github.com/guru-irl/rspack/tree/fix/inline-const-concat-active-panic

With it applied:

- the repo above builds on 2.1.2,
- the two production apps build with their `sideEffects` workaround removed,
- and the existing suites still pass — `TreeShaking.test.js` (84), `configCases/inline-const` (24), `configCases/concatenate-modules` (48).

Happy to turn the repro into a `configCases` fixture and open a PR if that's useful.
