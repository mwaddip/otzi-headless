import Ajv from 'ajv/dist/2020.js';
import { resolveAbiMethods } from './model.js';

let cachedSchema = null;
let cachedValidator = null;

function getValidator(schema) {
  if (cachedSchema !== schema) {
    cachedSchema = schema;
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

function crossFieldErrors(manifest) {
  const errors = [];
  const warnings = [];
  const contracts = manifest.contracts ?? {};
  const operations = manifest.operations ?? [];

  const idCounts = new Map();
  for (const op of operations) {
    if (op?.id) idCounts.set(op.id, (idCounts.get(op.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push({ path: `operations`, message: `duplicate operation id '${id}'` });
  }

  operations.forEach((op, i) => {
    if (!op || typeof op !== 'object') return;
    if (op.contract && op.contract !== '$dynamic' && !(op.contract in contracts)) {
      errors.push({
        path: `operations.${i}.contract`,
        message: `undefined contract key '${op.contract}'`,
      });
    }
    if (op.contract && op.contract !== '$dynamic' && op.method && contracts[op.contract]) {
      const methods = resolveAbiMethods(contracts[op.contract].abi);
      if (methods.length > 0 && !methods.includes(op.method)) {
        errors.push({
          path: `operations.${i}.method`,
          message: `method '${op.method}' not found in ABI for contract '${op.contract}'`,
        });
      }
    }
    (op.params ?? []).forEach((p, j) => {
      if (typeof p?.source !== 'string') return;
      const m = p.source.match(/^(contract|setting|read):(.+)$/);
      if (!m) return;
      const [, kind, key] = m;
      if (kind === 'contract' && !(key in contracts)) {
        errors.push({
          path: `operations.${i}.params.${j}.source`,
          message: `undefined contract key '${key}' in source`,
        });
      } else if (kind === 'setting') {
        warnings.push({
          path: `operations.${i}.params.${j}.source`,
          message: `setting key '${key}' is operator-supplied — verify it exists in your environment`,
        });
      }
    });
  });

  return { errors, warnings };
}

export function validateManifest(manifest, mode, schema) {
  const errors = schemaErrors(manifest, schema);
  const cross = crossFieldErrors(manifest);
  return {
    errors: [...errors, ...cross.errors],
    warnings: cross.warnings,
  };
}
