import Ajv from 'ajv/dist/2020.js';

let cachedSchema = null;
let cachedValidator = null;

function getValidator(schema) {
  if (cachedSchema !== schema) {
    cachedSchema = schema;
    // strict: false because the if/then conditional in the schema references
    // `type` in nested `properties` clauses; ajv-strict flags those as
    // ambiguous even though the meaning is unambiguous (the `if` is gated
    // by `required`). Mirrors src/cli/manifest-validate.ts.
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

function pathFromInstancePath(instancePath) {
  if (!instancePath) return '';
  return instancePath.replace(/^\//, '').replace(/\//g, '.');
}

function schemaErrors(manifest, schema) {
  const validator = getValidator(schema);
  const ok = validator(manifest);
  if (ok) return [];
  return (validator.errors ?? []).map((e) => ({
    path: pathFromInstancePath(e.instancePath),
    message: e.message ?? 'invalid',
  }));
}

/**
 * Cross-field rules NOT expressible in JSON Schema. Mirrors
 * src/cli/manifest-validate.ts exactly:
 * - Duplicate contract names within `contracts[]` are rejected.
 * - Duplicate method names within a Custom contract's `abi[]` are rejected.
 */
function crossFieldErrors(manifest) {
  const errors = [];
  const contracts = Array.isArray(manifest.contracts) ? manifest.contracts : [];

  const contractNames = new Set();
  for (const [i, c] of contracts.entries()) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name === 'string') {
      if (contractNames.has(c.name)) {
        errors.push({
          path: `contracts.${i}.name`,
          message: `duplicate contract name '${c.name}'`,
        });
      }
      contractNames.add(c.name);
    }

    if (c.type === 'Custom' && Array.isArray(c.abi)) {
      const methodNames = new Set();
      for (const [j, method] of c.abi.entries()) {
        if (!method || typeof method !== 'object') continue;
        if (typeof method.name !== 'string') continue;
        if (methodNames.has(method.name)) {
          errors.push({
            path: `contracts.${i}.abi.${j}.name`,
            message: `duplicate method name '${method.name}' in contract '${c.name}'`,
          });
        }
        methodNames.add(method.name);
      }
    }
  }

  return errors;
}

export function validateManifest(manifest, schema) {
  const errors = [...schemaErrors(manifest, schema), ...crossFieldErrors(manifest)];
  return { errors, warnings: [] };
}
