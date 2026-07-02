# rspack 2.1 panic: `should have module id` (inline-const + deferred pure-check + scope hoisting)

Minimal reproduction of a **regression introduced in rspack 2.1**. A production build
panics with:

```
thread 'tokio-*' panicked at ...:
should have module id
```

- **rspack 2.0.1** — builds cleanly ✅
- **rspack 2.1.0 / 2.1.2** — panics (`exit 134`) ❌

## Run it

```bash
npm install
npm run build          # @rspack/core 2.1.2 -> PANIC: "should have module id"

# prove it is a 2.1 regression:
npm install @rspack/core@2.0.1 @rspack/cli@2.0.1
npm run build          # -> compiles successfully
```

## What the graph looks like

```
src/app.ts
  ├─ import("@repro/components/components/AiHub")          (async chunk)
  │     └─ AiHub()  ──►  Inner()   (Inner is concatenated INTO AiHub)
  │                        └─ const useInnerStyles = makeStyles({ maxWidth: SEARCH_BOX_MAX_WIDTH, ... })
  └─ import("@repro/components/components/HomePage.styles") (async chunk)
        └─ const useHomePageStyles = makeStyles({ maxWidth: SEARCH_BOX_MAX_WIDTH, ... })

@repro/components/constants/stylingConstants.ts
        export const SEARCH_BOX_MAX_WIDTH = 731;   // short numeric consts
        export const SIDE_PANE_WIDTH      = 400;   // (inline-const eligible)
        ...

@repro/styling  (package.json: "sideEffects": false)
        makeStyles.ts   -> plain `function makeStyles(...)`  (NO /*#__NO_SIDE_EFFECTS__*/)
        renderer.ts     -> has a top-level side effect
```

## Why it panics (root cause)

Three 2.1 behaviors combine:

1. **inline-const** (new in 2.1, on by default in production via `optimization.inlineExports`).
   The short numeric `const`s are inlined at every use site, so
   `stylingConstants` ends up referenced by **zero** chunks (`n_chunks = 0`).

2. **Deferred pure-checks from a `sideEffects:false` package.**
   `@repro/styling` is `sideEffects:false`, so the consumer marks `makeStyles`
   as a side-effects-free *deferred* callee and attaches a **deferred pure-check**
   to each const import that feeds a `makeStyles(...)` call.

   The impurity test (`deferred_pure_check_is_impure`) reads the target module's
   **per-export** `side_effects_free` set — which package-level `sideEffects:false`
   never populates (only `/*#__NO_SIDE_EFFECTS__*/` / numeric consts do). So the
   check resolves to the deep `makeStyles.ts` module (side-effectful sibling
   import ⇒ per-export set is `None`) and returns **impure = true**.
   *(This mirrors `@griffel/react`: a `sideEffects:false` package exporting a plain
   `function makeStyles` re-exported through a barrel.)*

3. **Scope hoisting (`concatenateModules`).**
   `Inner` is concatenated into `AiHub`. The concatenation **clones** `Inner`'s
   const import dependency. In the cloned/concatenated context
   `connection_active_for_esm_import_specifier` sees
   `has_impure_deferred_pure_checks = true` and — in stock 2.1 — **short-circuits to
   `active = true` before checking whether the export was inlined.** It therefore
   emits an external `__webpack_require__(<module id>)` reference to the const
   module, which was already inlined to **zero chunks** → `get_module_id(...).expect("should have module id")` → **panic**.

### The trigger, in one line

A connection that carries an **impure deferred pure-check** *and* whose export was
**inlined away** is marked active by stock 2.1, producing an external reference to a
0-chunk module. The correct behavior is: **an inlined export wins** — the connection
must be inactive.

### The fix

In `connection_active_for_esm_import_specifier`, evaluate the inline-value check
**first** and return `false` (inactive) when the export is inlined, *before* the
`used_by_exports` / `has_impure_deferred_pure_checks` short-circuit.

## Required config knobs (all realistic production defaults)

- `optimization.concatenateModules: true` (scope hoisting)
- `optimization.inlineExports: true` (default in production)
- `optimization.sideEffects: true` (default in production)
- `experiments.pureFunctions` (defaults to `true` in production — enables deferred pure-checks)
- swc-loader `jsc.target: "esnext"` — **required**: downleveled targets rewrite
  `const` → `var` and disable inline-const, hiding the bug.

## Files

| File | Role |
|------|------|
| `src/app.ts` | entry: two async (deep-path) imports |
| `packages/components/components/Inner.tsx` | `const = makeStyles({...const...})`; concatenated into AiHub |
| `packages/components/components/AiHub.tsx` | async root; imports Inner; no direct const import |
| `packages/components/components/HomePage.styles.ts` | second async user of the consts (inlining pressure) |
| `packages/components/constants/stylingConstants.ts` | short numeric consts (inline-const eligible) |
| `packages/styling/*` | `sideEffects:false` package; plain `makeStyles`, side-effectful sibling |
