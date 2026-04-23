export type StorageMode = 'persistent' | 'encrypted-persistent' | 'encrypted-portable';
export type NetworkName = 'testnet' | 'mainnet';

export interface SetupState {
  wizardComplete: boolean;
  dkgComplete: boolean;
}

export interface WalletConfig {
  mnemonic: string;
  p2tr: string;
  tweakedPubKey: string;
  publicKey: string;
}

export interface PermafrostConfig {
  threshold: number;
  parties: number;
  level: number;
  combinedPubKey: string;
  shareData: string;
  frostAggregateKey?: string;
  frostUntweakedAggregateKey?: string;
  frostP2tr?: string;
  frostLegacySig?: string;  // 64-byte hex, FROST Schnorr sig over key-link message
}

export interface ContractConfig {
  name: string;
  address: string;
  abi: unknown[];
  methods: string[];
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
  version: number;
  network: NetworkName;
  storageMode: StorageMode;
  setupState: SetupState;
  adminPasswordHash?: string;
  authMode?: 'password' | 'wallet';
  wallet?: WalletConfig;
  permafrost?: PermafrostConfig;
  contracts: ContractConfig[];
  hosting?: HostingConfig;
  manifestConfig?: unknown;
}

export function defaultConfig(network: NetworkName, storageMode: StorageMode): VaultConfig {
  return {
    version: 1,
    network,
    storageMode,
    setupState: {
      wizardComplete: true,
      dkgComplete: false,
    },
    contracts: [],
  };
}

/** Sanitize config for frontend — strip private keys and admin hash */
export function sanitizeConfig(config: VaultConfig): Record<string, unknown> {
  const { wallet, adminPasswordHash: _, ...rest } = config;
  if (!wallet) return { ...rest, hasAdminPassword: !!config.adminPasswordHash };
  const { mnemonic: _m, ...safeWallet } = wallet;
  return { ...rest, wallet: safeWallet, hasAdminPassword: !!config.adminPasswordHash };
}
