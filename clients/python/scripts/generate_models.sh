#!/usr/bin/env bash
# Regenerates src/india_subscriptions/models.py from ../../openapi/openapi.json.
#
#   scripts/generate_models.sh            # rewrite the committed file
#   scripts/generate_models.sh OUT.py     # write somewhere else (tests/test_models_generated.py does this)
#
# Needs datamodel-code-generator==0.97.0 (pinned in pyproject.toml, "dev" extra). It is found in
# ./.venv, or on PATH. Nothing here edits the output afterwards: every choice below is a generator
# option, and each one answers a concrete defect or gap in the plain output:
#
#   --target-python-version 3.10 + --no-use-union-operator
#       0.97 cannot target 3.9 any more. The package supports 3.9, so unions are written
#       Optional[...] / Union[...] (never `X | Y`), which pydantic can evaluate on 3.9.
#   --use-standard-collections            list[...] / dict[...] (valid at runtime on 3.9).
#   --snake-case-field + --allow-population-by-field-name
#       snake_case attributes, camelCase JSON aliases, both accepted on input.
#   --use-subclass-enum --capitalise-enum-members
#       enums are `class X(str, Enum)` with UPPER_CASE members: Provider.RAZORPAY.
#   --set-default-enum-member             defaults are enum members, not bare strings.
#   --type-mappings email=string
#       the default EmailStr needs the optional email-validator package; the server validates the
#       address and the generated pattern constraint is kept.
#   --collapse-root-models + --collapse-constrained-root-models-as-annotated
#       CreateSubscriptionInput.plan is Union[CreatePlanInput, constrained str], not a RootModel
#       wrapper the caller would have to construct.
#   --use-field-description + --use-schema-description
#       the spec carries descriptions; they become field descriptions and class docstrings.
#   --extra-fields ignore + --extra-template-data scripts/model_config.json
#       responses ignore unknown keys, so a newer service does not break an older client; request
#       models forbid them, so a typo in a dict input fails loudly instead of being dropped.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
spec="$root/../../openapi/openapi.json"
out="${1:-$root/src/india_subscriptions/models.py}"

if [[ -x "$root/.venv/bin/datamodel-codegen" ]]; then
  codegen="$root/.venv/bin/datamodel-codegen"
else
  codegen="datamodel-codegen"
fi

header='# GENERATED FILE - DO NOT EDIT.
# Source: openapi/openapi.json (generated from the TypeScript Zod schemas by `npm run openapi`).
# Regenerate with: clients/python/scripts/generate_models.sh
# tests/test_models_generated.py fails when this file drifts from the spec.
# ruff: noqa
# mypy: ignore-errors'

cd "$root"
"$codegen" \
  --input "$spec" \
  --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.10 \
  --use-standard-collections \
  --no-use-union-operator \
  --snake-case-field \
  --allow-population-by-field-name \
  --use-subclass-enum \
  --capitalise-enum-members \
  --set-default-enum-member \
  --use-annotated \
  --field-constraints \
  --strict-nullable \
  --use-field-description \
  --use-schema-description \
  --collapse-root-models \
  --collapse-constrained-root-models-as-annotated \
  --type-mappings email=string \
  --extra-fields ignore \
  --extra-template-data "$here/model_config.json" \
  --disable-timestamp \
  --formatters builtin \
  --custom-file-header "$header" \
  --output "$out" 2> >(grep -v -e UserWarning -e 'lambda self' -e FutureWarning -e 'warnings.warn' >&2)
