/** Test helper: run a complete FROST DKG in-process through the blob codec. Not used at runtime. */

import {
  dkgRound1, dkgRound2, dkgFinalize,
  type KeyPackage, type PublicKeyPackage, type Round1SecretPackage,
} from '@mwaddip/frots';
import {
  encodeFrostRound1, decodeFrostRound1, encodeFrostRound2, decodeFrostRound2,
  partyIdToFrostId, generateSessionId, type FrostRound1Package, type FrostRound2Package,
} from './dkg';

export const rng = { fillBytes: (d: Uint8Array) => { crypto.getRandomValues(d); } };

export interface DkgResult {
  sessionId: Uint8Array;
  keyPackages: KeyPackage[];
  publicKeyPackages: PublicKeyPackage[];
}

export function runDkg(t: number, n: number): DkgResult {
  const sessionId = generateSessionId();
  const r1Secrets: Round1SecretPackage[] = [];
  const r1Blobs: string[] = [];
  for (let p = 0; p < n; p++) {
    const { secretPackage, package: pkg } = dkgRound1(partyIdToFrostId(p), n, t, rng);
    r1Secrets.push(secretPackage);
    r1Blobs.push(encodeFrostRound1(pkg, sessionId));
  }
  const r1 = r1Blobs.map(b => decodeFrostRound1(b)!);
  const othersR1 = (p: number) => new Map<bigint, FrostRound1Package>(r1.filter((_, j) => j !== p).map(x => [x.identifier, x]));

  const r2Secrets = [];
  const r2Blobs = new Map<string, string>(); // `${from}->${to}`
  for (let p = 0; p < n; p++) {
    const { secretPackage, packages } = dkgRound2(r1Secrets[p]!, othersR1(p));
    r2Secrets.push(secretPackage);
    for (const [, pkg] of packages) r2Blobs.set(`${pkg.sender}->${pkg.recipient}`, encodeFrostRound2(pkg, sessionId));
  }

  const keyPackages: KeyPackage[] = [];
  const publicKeyPackages: PublicKeyPackage[] = [];
  for (let p = 0; p < n; p++) {
    const me = partyIdToFrostId(p);
    const received = new Map<bigint, FrostRound2Package>();
    for (let q = 0; q < n; q++) {
      if (q === p) continue;
      const pkg = decodeFrostRound2(r2Blobs.get(`${partyIdToFrostId(q)}->${me}`)!)!;
      received.set(pkg.sender, pkg);
    }
    const { keyPackage, publicKeyPackage } = dkgFinalize(r2Secrets[p]!, othersR1(p), received);
    keyPackages.push(keyPackage);
    publicKeyPackages.push(publicKeyPackage);
  }
  return { sessionId, keyPackages, publicKeyPackages };
}
