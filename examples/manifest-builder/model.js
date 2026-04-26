const SHORTHAND_METHODS = {
  OP_20: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'transferFrom', 'approve'],
  OP_20S: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'transferFrom', 'approve', 'pegRate', 'setPegRate'],
  OP_721: ['name', 'symbol', 'totalSupply', 'balanceOf', 'ownerOf', 'tokenURI', 'transferFrom', 'approve', 'setApprovalForAll'],
};

export function emptyManifest() {
  return {
    version: 2,
    name: '',
    description: '',
    contracts: {},
    operations: [],
  };
}

export function renameContractKey(manifest, oldKey, newKey) {
  if (oldKey === newKey) return manifest;
  if (!(oldKey in manifest.contracts)) return manifest;
  if (newKey in manifest.contracts) {
    throw new Error(`Contract key '${newKey}' already exists`);
  }
  const nextContracts = {};
  for (const [k, v] of Object.entries(manifest.contracts)) {
    nextContracts[k === oldKey ? newKey : k] = v;
  }
  const nextOps = manifest.operations.map((op) => {
    const next = { ...op };
    if (op.contract === oldKey) next.contract = newKey;
    if (Array.isArray(op.params)) {
      next.params = op.params.map((p) => {
        const np = { ...p };
        if (p.source === `contract:${oldKey}`) np.source = `contract:${newKey}`;
        if (p.options) {
          np.options = {
            count: { ...p.options.count },
            item: { ...p.options.item },
          };
          if (np.options.count.contract === oldKey) np.options.count.contract = newKey;
          if (np.options.item.contract === oldKey) np.options.item.contract = newKey;
        }
        return np;
      });
    }
    return next;
  });
  return { ...manifest, contracts: nextContracts, operations: nextOps };
}

function stripOperation(op) {
  const out = {
    id: op.id, label: op.label, contract: op.contract, method: op.method,
    params: (op.params ?? []).map((p) => stripParam(p)),
  };
  if (op.description) out.description = op.description;
  return out;
}

function stripParam(p) {
  const out = { name: p.name, type: p.type };
  if (typeof p.scale === 'number') out.scale = p.scale;
  if (p.source && !p.source.startsWith('read:')) {
    // read: sources require reads polling, not supported headless — omit.
    out.source = p.source;
  }
  return out;
}

export function exportManifest(manifest) {
  const out = {
    version: manifest.version,
    name: manifest.name,
    contracts: {},
    operations: (manifest.operations ?? []).map((op) => stripOperation(op)),
  };
  if (manifest.description) out.description = manifest.description;
  for (const [k, v] of Object.entries(manifest.contracts ?? {})) {
    out.contracts[k] = { label: v.label, abi: v.abi, address: v.address };
  }
  return out;
}

export function resolveAbiMethods(abi) {
  if (typeof abi === 'string') return SHORTHAND_METHODS[abi] ?? [];
  if (!Array.isArray(abi)) return [];
  const methods = [];
  for (const entry of abi) {
    if (typeof entry === 'string') {
      methods.push(...(SHORTHAND_METHODS[entry] ?? []));
    } else if (entry && entry.type === 'Function' && typeof entry.name === 'string') {
      methods.push(entry.name);
    }
  }
  return methods;
}
