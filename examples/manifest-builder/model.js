/**
 * State + export helpers for the headless-manifest-v1 builder.
 *
 * State shape mirrors the schema 1:1 — contracts is an array of
 * `{ name, address, type, decimals?, abi? }`. No transformation needed
 * at export time beyond trimming optional/conditional fields per type.
 */

export function emptyManifest() {
  return {
    version: 1,
    name: '',
    description: '',
    contracts: [],
  };
}

export function contractTypeRequiresDecimals(type) {
  return type === 'OP20' || type === 'OP20S';
}

export function contractTypeRequiresAbi(type) {
  return type === 'Custom';
}

function stripContract(c) {
  const out = { name: c.name, address: c.address, type: c.type };
  if (contractTypeRequiresDecimals(c.type)) {
    out.decimals = c.decimals;
  }
  if (contractTypeRequiresAbi(c.type)) {
    out.abi = c.abi;
  }
  return out;
}

export function exportManifest(manifest) {
  const out = {
    version: manifest.version,
    name: manifest.name,
    contracts: (manifest.contracts ?? []).map((c) => stripContract(c)),
  };
  if (manifest.description) out.description = manifest.description;
  return out;
}
