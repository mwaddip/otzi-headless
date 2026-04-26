/**
 * ajv-driven validator for the headless-manifest-v1 format.
 *
 * Returns a discriminated result so callers can either accept a typed
 * manifest or dump the structured errors with full JSON-pointer paths.
 *
 * Cross-field rules NOT expressible in JSON Schema:
 * - Duplicate contract names within `contracts[]` are rejected.
 * - Duplicate method names within a contract's `abi[]` are rejected.
 *
 * The vendored schema lives at `docs/headless-manifest-schema.json` and is
 * imported as JSON so esbuild inlines it at bundle time (the .deb ships a
 * single .mjs and does not include `docs/`).
 */

import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';
import schema from '../../docs/headless-manifest-schema.json' with { type: 'json' };
import type { HeadlessManifest } from './manifest-types';

// `strict: false` because the if/then conditional in the schema references
// `type` in nested `properties` clauses; ajv-strict flags those as ambiguous
// even though the meaning is unambiguous (the `if` is gated by `required`).
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile<HeadlessManifest>(schema as object);

export type ValidationResult =
  | { ok: true; manifest: HeadlessManifest }
  | { ok: false; errors: string[] };

export function validateManifest(input: unknown): ValidationResult {
  const valid = validateSchema(input);
  if (!valid) {
    return { ok: false, errors: formatErrors(validateSchema.errors ?? []) };
  }

  const m = input;

  const errors: string[] = [];
  const contractNames = new Set<string>();
  for (const [i, c] of m.contracts.entries()) {
    if (contractNames.has(c.name)) {
      errors.push(`/contracts/${i}/name: duplicate contract name '${c.name}'`);
    }
    contractNames.add(c.name);

    if (c.type === 'Custom' && c.abi) {
      const methodNames = new Set<string>();
      for (const [j, method] of c.abi.entries()) {
        if (methodNames.has(method.name)) {
          errors.push(
            `/contracts/${i}/abi/${j}/name: duplicate method name '${method.name}' in contract '${c.name}'`,
          );
        }
        methodNames.add(method.name);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: m };
}

function formatErrors(errs: ErrorObject[]): string[] {
  return errs.map((e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`);
}
