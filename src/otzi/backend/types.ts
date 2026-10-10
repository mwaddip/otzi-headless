export type StorageMode = 'persistent' | 'encrypted-persistent' | 'encrypted-portable';
export type NetworkName = 'mainnet' | 'testnet4' | 'signet';
export type AuthMode = 'password' | 'accounts';

export const NETWORK_NAMES: readonly NetworkName[] = ['mainnet', 'testnet4', 'signet'];
export const STORAGE_MODES: readonly StorageMode[] = ['persistent', 'encrypted-persistent', 'encrypted-portable'];
export const AUTH_MODES: readonly AuthMode[] = ['password', 'accounts'];

/** FROST PublicKeyPackage, hex-encoded. Keys of the share maps are FROST identifiers ("1".."N"). */
export interface VaultKey {
  minSigners: number;
  verifyingKey: string;            // 33-byte SEC1 hex — BIP341 output key
  untweakedVerifyingKey: string;   // 33-byte SEC1 hex — BIP341 internal key
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

export interface VaultConfig {
  version: 2;
  network: NetworkName;
  storageMode: StorageMode;
  authMode: AuthMode;
  adminPasswordHash?: string;
  esploraUrl?: string;
  vault?: VaultKey;
  addressBook: AddressBookEntry[];
  hosting?: HostingConfig;
}

export function defaultConfig(network: NetworkName, storageMode: StorageMode, authMode: AuthMode): VaultConfig {
  return { version: 2, network, storageMode, authMode, addressBook: [] };
}
