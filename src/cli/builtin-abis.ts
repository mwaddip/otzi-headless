/**
 * Canonical mutating-method tables for built-in contract types.
 *
 * Read-only methods (balanceOf / name / symbol / decimals / totalSupply /
 * etc.) are deliberately absent — manifests don't list them and operators
 * don't sign reads. To call a method NOT in this table, declare the
 * contract as `type: 'Custom'` and list the method explicitly.
 *
 * Method sets are the OPNet standard mutating subset for each type, taken
 * from `node_modules/opnet/build/abi/shared/json/opnet/`. Methods using
 * types the calldata encoder doesn't natively support (notably `bool` for
 * OP721's `setApprovalForAll`, and `string` for OP721's `changeMetadata` /
 * `setBaseURI`) are excluded — operators who need them can declare the
 * contract as `Custom` and own the encoding caveat.
 */

import type { AbiMethod } from './manifest-types';

export const OP20_METHODS: readonly AbiMethod[] = [
  {
    name: 'transfer',
    params: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'transferFrom',
    params: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'safeTransfer',
    params: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'safeTransferFrom',
    params: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'increaseAllowance',
    params: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'decreaseAllowance',
    params: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'burn',
    params: [{ name: 'amount', type: 'uint256' }],
  },
  {
    name: 'mint',
    params: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
];

/**
 * OP20S = OP20 + peg-rate stablecoin extensions (updatePegRate,
 * updateMaxStaleness, peg-authority transfer/accept/renounce).
 */
export const OP20S_METHODS: readonly AbiMethod[] = [
  ...OP20_METHODS,
  {
    name: 'updatePegRate',
    params: [{ name: 'newRate', type: 'uint256' }],
  },
  {
    name: 'updateMaxStaleness',
    params: [{ name: 'newStaleness', type: 'uint64' }],
  },
  {
    name: 'transferPegAuthority',
    params: [{ name: 'newAuthority', type: 'address' }],
  },
  {
    name: 'acceptPegAuthority',
    params: [],
  },
  {
    name: 'renouncePegAuthority',
    params: [],
  },
];

/**
 * OP721 — NFT-style. Mutating subset: safeTransfer / safeTransferFrom /
 * approve / burn. `setApprovalForAll(operator, approved: bool)` is omitted
 * because the calldata encoder doesn't support `bool`; the same goes for
 * `changeMetadata` and `setBaseURI` (string args). Use Custom for those.
 */
export const OP721_METHODS: readonly AbiMethod[] = [
  {
    name: 'safeTransfer',
    params: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    name: 'safeTransferFrom',
    params: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    name: 'approve',
    params: [
      { name: 'operator', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    name: 'burn',
    params: [{ name: 'tokenId', type: 'uint256' }],
  },
];

export function methodsForBuiltinType(
  type: 'OP20' | 'OP20S' | 'OP721',
): readonly AbiMethod[] {
  switch (type) {
    case 'OP20':
      return OP20_METHODS;
    case 'OP20S':
      return OP20S_METHODS;
    case 'OP721':
      return OP721_METHODS;
  }
}
