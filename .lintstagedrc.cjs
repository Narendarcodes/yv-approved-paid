// lint-staged (run by .husky/pre-commit). Runs with --concurrent false, so the
// tasks below run in order on the staged files: ESLint --fix first (each app
// with its own config and its own eslint version), then Prettier on every
// staged file. Prettier skips anything in .prettierignore and anything it
// cannot parse (--ignore-unknown).
const eslintIn = (app) => (files) =>
  files.length
    ? `node scripts/eslint-in.cjs ${app} ${files.map((f) => JSON.stringify(f)).join(' ')}`
    : [];

module.exports = {
  'apps/web/src/**/*.{ts,tsx,js,jsx}': eslintIn('apps/web'),
  'apps/api/{src,tests,scripts}/**/*.{js,cjs,ts}': eslintIn('apps/api'),
  '*': 'prettier --ignore-unknown --write',
};
