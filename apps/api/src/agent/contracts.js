/** Runtime validation against the shared JSON Schemas (contracts/ is the single source). */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const dir = path.join(__dirname, '..', 'contracts', 'schemas');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function validate(name, data) {
  const v = ajv.getSchema(`${name}.json`);
  if (!v) throw new Error(`unknown schema ${name}`);
  const ok = v(data);
  return { ok, errors: ok ? [] : v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`) };
}

module.exports = { validate };
