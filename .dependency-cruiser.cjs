// @ts-check
// Deep-module enforcement for dependency-cruiser.
//
// Each package under the packages root is a DEEP MODULE: a lot of behaviour
// behind a small interface. A package's PUBLIC SURFACE is its ENTRY POINTS:
// the files at the package root. Implementation lives in SUBFOLDERS and is
// private (by convention `lib/` for implementation and `tests/` for tests,
// though any subfolder is private). A package may expose several small entry
// points (index.ts, client.ts, server.ts, …); prefer that over one giant
// barrel index.
//
// The only thing you should ever need to edit here is PACKAGES_ROOT.

/** Where packages live. One immediate child dir per package (flat, no nesting). */
const PACKAGES_ROOT = 'apps/api/src/modules';

// --- derived patterns (no need to edit) -------------------------------------
const R = PACKAGES_ROOT;
/**
 * A package's private internals: anything nested inside a package subfolder.
 * The package's root files are its entry points and are NOT matched here:
 * they stay importable from outside.
 */
const PACKAGE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'entrypoint-boundary-from-app',
      comment:
        "App/root code may import a package's entry points (its root files), but nothing inside its subfolders.",
      severity: 'error',
      from: { pathNot: `^${R}/` }, // importer is NOT inside any package
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: 'entrypoint-boundary-across-packages',
      comment:
        "A package's own files import each other freely, but may reach OTHER packages only through their entry points, never their internals.",
      severity: 'error',
      // importer is inside a package ($1), but is not a test file
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/`, // same package → intra-package freedom
      },
    },
    {
      name: 'tests-through-entrypoints',
      comment:
        "A package's tests exercise it through its entry points like everyone else: they may import any package's entry points and their own tests/ fixtures, but never any package's internals, not even their own.",
      severity: 'error',
      from: { path: `^${R}/([^/]+)/tests/` }, // a test file, in package $1
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/tests/`, // own tests/ fixtures → allowed
      },
    },
    {
      name: 'tests-folder-is-private',
      comment:
        "A package's tests/ folder is reachable only from tests: nothing else may import fixtures.",
      severity: 'error',
      from: { pathNot: `^${R}/[^/]+/tests/` }, // importer is not itself a test
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: 'no-circular',
      comment:
        'No dependency cycles. Scope to `^${R}/` if you want to allow cycles outside packages.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    // --- Layering (yv.; see docs/adr/0010 and arch-audit stack-and-data Q2) --
    // Interface-hiding controls HOW you import (through the entry points).
    // Layering controls WHICH modules may depend on which. These start as
    // "warn" because the modules are not extracted yet (Phase 1-4 create
    // them). Flip each to "error" when its module lands.
    {
      name: 'platform-imports-no-domain-module',
      comment:
        'modules/platform is infrastructure (jobs, config adapters): it imports no other module.',
      severity: 'warn',
      from: { path: `^${R}/platform/` },
      to: { path: `^${R}/`, pathNot: `^${R}/platform/` },
    },
    {
      name: 'content-does-not-import-downstream',
      comment:
        'content (projects, versions, lifecycle) never imports publishing, review or performance; they depend on it, not the reverse.',
      severity: 'warn',
      from: { path: `^${R}/content/` },
      to: { path: `^${R}/(publishing|review|performance)/` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|coverage|uploads)/' },
    tsConfig: { fileName: 'apps/api/tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.cts', '.ts', '.tsx', '.js', '.cjs', '.jsx', '.json'],
    },
  },
};
