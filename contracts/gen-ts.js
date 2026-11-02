// Compile every JSON Schema in ./schemas into one .d.ts file (deterministic order).
const fs = require('fs');
const path = require('path');
const { compile } = require('json-schema-to-typescript');

const declared = (ts) => [...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
/** Split compiled output into top-level declarations (each with its own JSDoc). */
function declarations(ts) {
  const out = [];
  let prev = '';
  for (const line of ts.split('\n')) {
    if (line.startsWith('/**') || (line.startsWith('export ') && !prev.startsWith(' */'))) out.push([]);
    if (out.length && line.trim()) out[out.length - 1].push(line);
    prev = line;
  }
  return out.map((l) => l.join('\n'));
}

(async () => {
  const dir = path.join(__dirname, 'schemas');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  let out = '/* AUTO-GENERATED from contracts/schemas by contracts/gen.sh. Do not edit. */\n';
  const seen = new Set();
  for (const f of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    // a schema with local `definitions` (deal.schema.json) declares them too
    const local = !!schema.definitions;
    const opts = { bannerComment: '', cwd: dir, declareExternallyReferenced: local, additionalProperties: false };
    let ts = await compile(schema, schema.title, opts);
    if (local) {
      // definitions the root does not reach (ledger view, socket payload) are declared as well, once each
      const have = new Set(declared(ts));
      for (const [name, def] of Object.entries(schema.definitions).sort(([a], [b]) => a.localeCompare(b))) {
        const title = def.title || name;
        if (have.has(title)) continue;
        const extra = await compile({ ...def, title, definitions: schema.definitions }, title, opts);
        for (const block of declarations(extra)) {
          const names = declared(block);
          if (!names.length || names.some((n) => have.has(n))) continue;
          names.forEach((n) => have.add(n));
          ts += block + '\n';
        }
      }
    }
    out += ts + '\n';
    seen.add(schema.title);
  }
  fs.writeFileSync(process.argv[2], out);
})().catch((e) => { console.error(e); process.exit(1); });
