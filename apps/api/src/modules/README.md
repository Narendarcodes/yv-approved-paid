# apps/api/src/modules: deep modules

New and moved domain code lives here, one folder per module (`links`, `publishing`, `content`, `access`, `performance`, `platform`, …). See `docs/adr/0010-modular-monolith-with-role-processes.md`.

## Layout
```
modules/<name>/
  index.js|ts     entry point(s): the module's public surface, at the module root
  http.js|ts      optional extra entry points (routes, worker, lifecycle, …)
  lib/            private implementation; nothing outside the module imports it
  tests/          tests; they go through the entry points like any other caller
```

## Rules (enforced by dependency-cruiser, `.dependency-cruiser.cjs` at the repo root)
- Import another module **only through its root files**. Never reach into `<other>/lib/`.
- Tests import entry points, never `lib/`, not even their own module's.
- Nothing outside a module's `tests/` imports its test fixtures.
- **No barrel files.** Expose several small entry points (`index`, `http`, `worker`, `lifecycle`) instead of one index that re-exports everything.
- No dependency cycles anywhere in `apps/api/src`.
- Layering (warn until the modules exist): `platform` imports no other module; `content` never imports `publishing`, `review` or `performance`.

`example/` is the copy-me template. New modules may be written in TypeScript (ADR-0013; `npm --prefix apps/api run typecheck`).

## Run it
```
npm ci                    # at the repo root, once
npm run lint:boundaries   # from the repo root
```
CI runs the same command.
