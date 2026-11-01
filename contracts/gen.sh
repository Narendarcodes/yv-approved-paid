#!/usr/bin/env bash
# Single source of truth: contracts/schemas/*.json (+ openapi/internal.yaml referencing them).
# Generates TS types (api + web) and Pydantic v2 models (agent). CI fails if output drifts.
set -euo pipefail
cd "$(dirname "$0")"
TS_OUT_API=../apps/api/src/contracts
TS_OUT_WEB=../apps/web/src/contracts
PY_OUT=../services/agent/app/contracts
mkdir -p "$TS_OUT_API" "$TS_OUT_WEB" "$PY_OUT"
node gen-ts.js "$TS_OUT_API/types.d.ts"
cp "$TS_OUT_API/types.d.ts" "$TS_OUT_WEB/types.d.ts"
${PYTHON:-python3} -m datamodel_code_generator --input schemas --input-file-type jsonschema --output "$PY_OUT" \
  --output-model-type pydantic_v2.BaseModel --disable-timestamp --use-standard-collections \
  --target-python-version 3.11 --use-title-as-name --formatters black isort
# copy raw schemas next to the API so Node can validate job payloads at runtime (ajv)
mkdir -p "$TS_OUT_API/schemas" && cp schemas/*.json "$TS_OUT_API/schemas/"
echo "contracts generated"
