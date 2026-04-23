// ── Manifest schema types ──

export interface ProjectManifest {
  version: number;
  name: string;
  description?: string;
  icon?: string;
  theme?: ManifestTheme;
  contracts: Record<string, ManifestContract>;
  reads?: Record<string, ManifestRead>;
  status?: ManifestStatusEntry[];
  operations: ManifestOperation[];
}

export interface ManifestThemeColors {
  accent?: string;
  accentHover?: string;
  bg?: string;
}

export interface ManifestTheme {
  dark?: ManifestThemeColors;
  light?: ManifestThemeColors;
  // Legacy flat fields — treated as dark mode values
  accent?: string;
  accentHover?: string;
  bg?: string;
  radius?: string;
}

export interface ManifestContract {
  label: string;
  abi: unknown[] | string;
}

export interface ManifestReadParam {
  type: 'address' | 'uint256' | 'bool';
  source: string; // "contract:<key>", "setting:<key>", "read:<key>"
}

export interface ManifestRead {
  contract: string;
  method: string;
  params?: ManifestReadParam[];
  returns: 'uint8' | 'uint256' | 'address' | 'bool' | 'string';
  format?: 'raw' | 'token8' | 'btc8' | 'percent8' | 'price8' | 'address';
}

export interface ManifestStatusEntry {
  label: string;
  read: string;
  map?: Record<string, string>;
  condition?: ManifestCondition;
}

export interface ManifestOperation {
  id: string;
  label: string;
  description?: string;
  contract: string;
  method: string;
  condition?: ManifestCondition;
  ownerOnly?: boolean;
  confirm?: string;
  params: ManifestParam[];
}

export interface ManifestParamOptions {
  count: { contract: string; method: string };
  item: { contract: string; method: string };
}

export interface ManifestParam {
  name: string;
  type: 'uint256' | 'address' | 'bool' | 'bytes';
  label?: string;
  scale?: number;
  placeholder?: string;
  source?: string;
  options?: ManifestParamOptions;
}

// ── Conditions ──

export type ManifestCondition =
  | { read: string; eq: number | string | boolean }
  | { read: string; neq: number | string | boolean }
  | { read: string; gt: number }
  | { read: string; lt: number }
  | { blockWindow: { read: string; minBlocks?: number; maxBlocks?: number } }
  | { and: ManifestCondition[] }
  | { or: ManifestCondition[] }
  | { not: ManifestCondition };

// ── Address mapping (stored in VaultConfig) ──

export interface ManifestConfig {
  manifest: ProjectManifest;
  addresses: Record<string, string>;
  settings?: Record<string, string>;
}
