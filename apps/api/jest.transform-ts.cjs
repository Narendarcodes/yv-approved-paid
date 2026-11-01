// Jest transform for TypeScript sources (.ts/.cts) without a TS toolchain:
// Node's own type stripper (the same one that runs .cts at runtime, Node
// >= 22.18 / 24; ADR-0013). Erasable syntax only, so stripping is the whole job.
const { stripTypeScriptTypes } = require('node:module');

module.exports = {
  process(sourceText) {
    return { code: stripTypeScriptTypes(sourceText, { mode: 'strip' }) };
  },
};
