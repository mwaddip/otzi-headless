/** Shared types used by the API client and frontend components. */

export type StorageMode = 'persistent' | 'encrypted-persistent' | 'encrypted-portable';
export type NetworkName = 'mainnet' | 'testnet4' | 'signet';
export type AuthMode = 'password' | 'accounts';

export const NETWORK_LABELS: Record<NetworkName, string> = {
  mainnet: 'Mainnet',
  testnet4: 'Testnet4',
  signet: 'Signet',
};

/** FROST PublicKeyPackage, hex-encoded. Share map keys are FROST identifiers ("1".."N"). */
export interface VaultKey {
  minSigners: number;
  verifyingKey: string;
  untweakedVerifyingKey: string;
  verifyingShares: Record<string, string>;
  untweakedVerifyingShares: Record<string, string>;
}

export interface AddressBookEntry {
  label: string;
  address: string;
  note?: string;
}

export interface HostingConfig {
  domain: string;
  port?: number;
  path?: string;
  httpsEnabled: boolean;
  httpsStatus?: 'pending' | 'active' | 'error';
  httpsError?: string;
}

/** Config as served by GET /api/config (password hash removed, derived values added). */
export interface VaultConfig {
  version: 2;
  network: NetworkName;
  storageMode: StorageMode;
  authMode: AuthMode;
  esploraUrl?: string;
  vault?: VaultKey;
  addressBook: AddressBookEntry[];
  hosting?: HostingConfig;
  hasAdminPassword: boolean;
  chainApiUrl: string;
  vaultAddress?: string;
}

export interface Prevout {
  txid: string;
  vout: number;
  amount: number;
  script: string;
}

/** Unsigned send transaction as relayed to co-signers. */
export interface SendProposal {
  network: NetworkName;
  tx: string;
  prevouts: Prevout[];
}

export type UserCredentialPublic = { type: 'passkey' } | { type: 'bitcoin'; address: string };

export interface UserPublic {
  id: string;
  label: string;
  role: 'admin' | 'user';
  credential: UserCredentialPublic;
}

export interface Invite {
  code: string;
  role: 'admin' | 'user';
  usesLeft: number;
  expiresAt: number;
}
