/**
 * Thin I/O wrapper around `parseDaemonConfigToml`. Reads a TOML file and
 * returns a validated `DaemonConfig`. Share-file decryption + cross-validation
 * against the share lives in phase 5e (daemon entrypoint).
 */

import { readFile } from 'node:fs/promises';
import { parseDaemonConfigToml } from './parse';
import type { DaemonConfig } from './types';

export async function loadDaemonConfig(path: string): Promise<DaemonConfig> {
  const text = await readFile(path, 'utf8');
  return parseDaemonConfigToml(text);
}
