/**
 * Types for the headless-manifest-v1 format.
 *
 * Independent of Ötzi's v2 manifest schema — different products, different
 * use cases, no compatibility expected. The headless format is signing-only:
 * contracts + addresses + mutating-method ABIs. No UI fields.
 */

export type ContractType = 'OP20' | 'OP20S' | 'OP271' | 'Custom';

export type AbiParamType =
  | 'address'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'uint128'
  | 'uint256';

export interface AbiParam {
  name: string;
  type: AbiParamType;
}

export interface AbiMethod {
  name: string;
  params: AbiParam[];
}

export interface ManifestContract {
  name: string;
  address: string;
  type: ContractType;
  /** Required for OP20/OP20S; absent for OP271/Custom. */
  decimals?: number;
  /** Required for Custom; absent for built-in types. */
  abi?: AbiMethod[];
}

export interface HeadlessManifest {
  version: 1;
  name: string;
  description?: string;
  contracts: ManifestContract[];
}
