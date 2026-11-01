// Compile every JSON Schema in ./schemas into one .d.ts file (deterministic order).
const fs = require('fs');
const path = require('path');
const { compile } = require('json-schema-to-typescript');
(async () => {
  const dir = path.join(__dirname, 'schemas');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  let out = '/* AUTO-GENERATED from contracts/schemas by contracts/gen.sh. Do not edit. */\n';
  const seen = new Set();
  for (const f of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    let ts = await compile(schema, schema.title, { bannerComment: '', cwd: dir, declareExternallyReferenced: false, additionalProperties: false });
    out += ts + '\n';
    seen.add(schema.title);
  }
  fs.writeFileSync(process.argv[2], out);
})().catch((e) => { console.error(e); process.exit(1); });
