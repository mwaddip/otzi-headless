import { type Psbt, toXOnly, equals, isTaprootInput } from '@btc-vision/bitcoin';

/**
 * PSBT signer that uses the SDK's wallet-based (multiSignPsbt) code path.
 *
 * When the SDK detects `multiSignPsbt` on the signer object, it skips the
 * non-wallet path (which demands a raw private key for Taproot tweaking)
 * and instead hands us the entire PSBT to sign however we want.
 *
 * OPNet transactions have two kinds of inputs:
 * - Input 0: script-path (tapLeafScript). Needs signing by both scriptSigner
 *   (already done before multiSignPsbt) AND the main signer with the raw
 *   (untweaked) key. Produces tapScriptSig.
 * - Inputs 1+: key-path (tapInternalKey). Needs signing with the tweaked key.
 *   Produces tapKeySig.
 *
 * Reference: UnisatSigner.multiSignPsbt in
 * @btc-vision/transaction/build/transaction/browser/extensions/UnisatSigner.js
 */

export interface SighashInfo {
  index: number;
  hash: Uint8Array;
  type: 'script-path' | 'key-path';
}

/** Per-input sighash captured during a single multiSignPsbt call */
export interface InputSighash {
  inputIndex: number;
  hash: Uint8Array;
  type: 'script-path' | 'key-path';
}

/** Tracks sighashes from one multiSignPsbt invocation (= one PSBT/transaction) */
export interface CapturedCall {
  sighashes: InputSighash[];
}

type SchnorrSignFn = (hash: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Minimal signer shape for signTaprootInputAsync */
interface TaprootSigner {
  readonly publicKey: Uint8Array;
  signSchnorr(hash: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export class FrostPsbtSigner {
  /** SEC1-encoded tweaked public key (33 bytes). Matches the on-chain output key. */
  readonly publicKey: Uint8Array;

  private readonly internalXOnly: Uint8Array;
  private readonly keyPathSignFn: SchnorrSignFn;
  private readonly scriptPathSigner?: TaprootSigner;

  /**
   * @param keyPathSignFn - Signs with the tweaked key for key-path inputs (1+)
   * @param tweakedPublicKey - 33-byte SEC1 tweaked aggregate key
   * @param internalXOnly - 32-byte x-only untweaked key for matching tapInternalKey
   * @param scriptPathSigner - Optional signer for script-path inputs (input 0).
   *   Must have publicKey = untweaked key and signSchnorr that signs with the raw key.
   */
  constructor(
    keyPathSignFn: SchnorrSignFn,
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    scriptPathSigner?: TaprootSigner,
  ) {
    this.keyPathSignFn = keyPathSignFn;
    this.publicKey = tweakedPublicKey;
    this.internalXOnly = internalXOnly;
    this.scriptPathSigner = scriptPathSigner;
  }

  /**
   * Create a signer from a precomputed 64-byte BIP340 Schnorr signature.
   * Used in the two-call FROST flow: backend returns sighash → frontend
   * runs ceremony → frontend POSTs sig → backend wraps it here.
   */
  static fromSignature(
    sig: Uint8Array,
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    scriptPathSigner?: TaprootSigner,
  ): FrostPsbtSigner {
    return new FrostPsbtSigner(() => sig, tweakedPublicKey, internalXOnly, scriptPathSigner);
  }

  /**
   * Create a capture signer that extracts sighashes from all multiSignPsbt
   * calls using dummy signatures. The SDK calls multiSignPsbt multiple
   * times (fee estimation + final builds). Each call's sighashes are
   * tracked separately in `calls` so the caller can identify which
   * correspond to the final funding and interaction transactions.
   *
   * Dummy sigs (64 zero bytes) pass through SDK finalization without
   * verification, so sendTransaction proceeds to broadcast (where the
   * caller should intercept via provider override).
   */
  static createCapture(
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    untweakedPublicKey: Uint8Array,
  ): {
    signer: FrostPsbtSigner;
    sighashes: SighashInfo[];
    calls: CapturedCall[];
  } {
    const sighashes: SighashInfo[] = [];
    const calls: CapturedCall[] = [];
    let globalIndex = 0;

    const signer = new FrostPsbtSigner(
      () => { throw new Error('capture signer: use multiSignPsbt'); },
      tweakedPublicKey,
      internalXOnly,
    );

    signer.multiSignPsbt = async (transactions: Psbt[]): Promise<void> => {
      for (const psbt of transactions) {
        const callSighashes: InputSighash[] = [];
        for (let i = 0; i < psbt.data.inputs.length; i++) {
          const input = psbt.data.inputs[i];
          if (!isTaprootInput(input)) continue;

          const isScriptPath = !!(input as Record<string, unknown>).tapLeafScript &&
            ((input as Record<string, unknown>).tapLeafScript as unknown[]).length > 0;
          const isKeyPath = !isScriptPath &&
            (input as Record<string, unknown>).tapInternalKey &&
            equals((input as Record<string, unknown>).tapInternalKey as Uint8Array, internalXOnly);

          if (!isScriptPath && !isKeyPath) continue;

          let capturedHash: Uint8Array | undefined;
          const dummySigner = {
            publicKey: isScriptPath ? untweakedPublicKey : tweakedPublicKey,
            signSchnorr(hash: Uint8Array) {
              capturedHash = new Uint8Array(hash);
              return new Uint8Array(64);
            },
          };

          await psbt.signTaprootInputAsync(i, dummySigner as never);

          const info: InputSighash = {
            inputIndex: i,
            hash: capturedHash!,
            type: isScriptPath ? 'script-path' : 'key-path',
          };
          callSighashes.push(info);
          sighashes.push({ index: globalIndex++, hash: info.hash, type: info.type });
        }
        calls.push({ sighashes: callSighashes });
      }
    };

    return { signer, sighashes, calls };
  }

  /**
   * Create a replay signer that applies precomputed FROST signatures,
   * matched by sighash. The SDK calls multiSignPsbt multiple times;
   * each call extracts the sighash and looks up the matching signature.
   */
  static createReplay(
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    untweakedPublicKey: Uint8Array,
    sigsByHash: Map<string, Uint8Array>,
  ): FrostPsbtSigner {
    const signer = new FrostPsbtSigner(
      () => { throw new Error('replay signer: use multiSignPsbt'); },
      tweakedPublicKey,
      internalXOnly,
    );

    signer.multiSignPsbt = async (transactions: Psbt[]): Promise<void> => {
      console.log(`[frost-replay] multiSignPsbt called with ${transactions.length} PSBTs, ${sigsByHash.size} sigs available`);
      for (const psbt of transactions) {
        for (let i = 0; i < psbt.data.inputs.length; i++) {
          const input = psbt.data.inputs[i];
          if (!isTaprootInput(input)) continue;

          const isScriptPath = !!(input as Record<string, unknown>).tapLeafScript &&
            ((input as Record<string, unknown>).tapLeafScript as unknown[]).length > 0;
          const isKeyPath = !isScriptPath &&
            (input as Record<string, unknown>).tapInternalKey &&
            equals((input as Record<string, unknown>).tapInternalKey as Uint8Array, internalXOnly);

          if (!isScriptPath && !isKeyPath) { console.log(`[frost-replay] input ${i}: skipped (not taproot key/script path)`); continue; }

          // Extract sighash to look up the matching FROST sig
          let capturedHash: Uint8Array | undefined;
          const captureSigner = {
            publicKey: isScriptPath ? untweakedPublicKey : tweakedPublicKey,
            signSchnorr(hash: Uint8Array) {
              capturedHash = new Uint8Array(hash);
              return new Uint8Array(64); // dummy — will be replaced
            },
          };

          await psbt.signTaprootInputAsync(i, captureSigner as never);

          // Delete dummy sig
          const inp = input as Record<string, unknown>;
          if (isScriptPath) delete inp.tapScriptSig;
          else delete inp.tapKeySig;

          // Apply real FROST sig
          const hashHex = Buffer.from(capturedHash!).toString('hex');
          const sig = sigsByHash.get(hashHex);
          if (!sig) {
            console.error(`[frost-replay] NO SIG for ${isScriptPath ? 'script' : 'key'}-path input ${i}, hash=${hashHex.slice(0, 16)}...`);
            console.error(`[frost-replay] Available hashes: ${[...sigsByHash.keys()].map(h => h.slice(0, 16)).join(', ')}`);
            throw new Error(`No FROST signature for sighash ${hashHex.slice(0, 16)}...`);
          }

          console.log(`[frost-replay] input ${i} (${isScriptPath ? 'script' : 'key'}-path): hash=${hashHex.slice(0, 16)}... → sig=${Buffer.from(sig).toString('hex').slice(0, 16)}...`);

          const realSigner = {
            publicKey: isScriptPath ? untweakedPublicKey : tweakedPublicKey,
            signSchnorr() { return sig; },
          };

          try {
            await psbt.signTaprootInputAsync(i, realSigner as never);
            console.log(`[frost-replay] input ${i} signed OK`);
          } catch (e) {
            console.error(`[frost-replay] input ${i} signTaprootInputAsync FAILED:`, e);
            throw e;
          }
        }
      }
      console.log('[frost-replay] multiSignPsbt complete');
    };

    return signer;
  }

  // -- Signer interface stubs (never called when multiSignPsbt is present) --

  sign(): Uint8Array {
    throw new Error('FrostPsbtSigner: use multiSignPsbt');
  }

  signSchnorr(hash: Uint8Array): Uint8Array | Promise<Uint8Array> {
    return this.keyPathSignFn(hash);
  }

  // -- Wallet-based signing path --

  async multiSignPsbt(transactions: Psbt[]): Promise<void> {
    for (const psbt of transactions) {
      for (let i = 0; i < psbt.data.inputs.length; i++) {
        const input = psbt.data.inputs[i];
        if (!isTaprootInput(input)) continue;

        // Script-path inputs: sign with raw (untweaked) key
        if (input.tapLeafScript?.length && this.scriptPathSigner) {
          await psbt.signTaprootInputAsync(i, this.scriptPathSigner as never);
          continue;
        }

        // Key-path inputs: sign with tweaked key
        if (input.tapKeySig) continue;
        if (!input.tapInternalKey || !equals(input.tapInternalKey, this.internalXOnly)) continue;
        await psbt.signTaprootInputAsync(i, this as never);
      }
    }
  }
}
