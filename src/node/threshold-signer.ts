import type { Network } from '@btc-vision/bitcoin';
import type { QuantumBIP32Interface } from '@btc-vision/bip32';
import { MLDSASecurityLevel } from '@btc-vision/bip32';

/**
 * Adapter that wraps a pre-computed threshold ML-DSA signature
 * to satisfy the QuantumBIP32Interface expected by the OPNet SDK.
 *
 * When the SDK calls sign(), it returns the pre-computed signature
 * rather than computing a new one.
 */
export class ThresholdMLDSASigner implements QuantumBIP32Interface {
  // QuantumBIP32Interface required fields — stubs
  readonly chainCode: Uint8Array = new Uint8Array(32);
  readonly network: Network = {} as Network;
  readonly depth: number = 0;
  readonly index: number = 0;
  readonly parentFingerprint: number = 0;
  readonly identifier: Uint8Array = new Uint8Array(20);
  readonly fingerprint: Uint8Array = new Uint8Array(4);
  readonly securityLevel: MLDSASecurityLevel = MLDSASecurityLevel.LEVEL2;

  // QuantumSigner: privateKey is optional
  readonly privateKey: undefined = undefined;

  constructor(
    private readonly precomputedSignature: Uint8Array,
    readonly publicKey: Uint8Array,
  ) {}

  sign(_message: Uint8Array): Uint8Array {
    return this.precomputedSignature;
  }

  verify(_hash: Uint8Array, _signature: Uint8Array): boolean {
    throw new Error('ThresholdMLDSASigner.verify() not implemented — SDK should not call this during sendTransaction');
  }

  isNeutered(): boolean {
    return true;
  }

  neutered(): QuantumBIP32Interface {
    return this;
  }

  derive(_index: number): QuantumBIP32Interface {
    throw new Error('derive not supported on ThresholdMLDSASigner');
  }

  deriveHardened(_index: number): QuantumBIP32Interface {
    throw new Error('deriveHardened not supported on ThresholdMLDSASigner');
  }

  derivePath(_path: string): QuantumBIP32Interface {
    throw new Error('derivePath not supported on ThresholdMLDSASigner');
  }

  toBase58(): string {
    throw new Error('toBase58 not supported on ThresholdMLDSASigner');
  }
}
