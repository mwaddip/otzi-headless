import { type Psbt, equals, isTaprootInput } from '@btc-vision/bitcoin';

/**
 * Composition-style replacement for the wallet.keypair graft in
 * `opnet-capture.ts`. Implements the minimal SDK signer surface:
 *
 *  - `publicKey` — read by the OPNet SDK at multiple sites
 *    (TweakedTransaction, TransactionBuilder, ConsolidatedInteractionTransaction,
 *    DeploymentTransaction). Set to the **untweaked** FROST aggregate key
 *    in SEC1 compressed form — matches the on-chain "sender" identity the
 *    contract layer commits to.
 *  - `multiSignPsbt(psbts)` — the wallet-mode signing entry point. The
 *    SDK detects this method and routes signing through it (skipping the
 *    raw-private-key tweaking path). For capture, we sign with dummy
 *    sigs and record each input's sighash so the FROST ceremony can run
 *    against them after the SDK finalizes the template txs.
 *
 * The sighash-extraction logic mirrors `FrostPsbtSigner.createCapture`'s
 * inner closure, but lives here as its own class so capture can compose
 * cleanly without grafting onto a real wallet keypair.
 *
 * One instance per capture run. Read `calls` (one entry per
 * multiSignPsbt invocation) or `allSighashes` (flattened, in call order)
 * after the SDK call settles.
 */

export interface InputSighash {
  inputIndex: number;
  hash: Uint8Array;
  type: 'script-path' | 'key-path';
}

export interface CapturedCall {
  sighashes: InputSighash[];
}

export class CaptureSigner {
  /** Untweaked SEC1-compressed FROST aggregate pubkey. SDK reads this directly. */
  readonly publicKey: Uint8Array;

  private readonly tweakedPublicKey: Uint8Array;
  private readonly internalXOnly: Uint8Array;
  private readonly _calls: CapturedCall[] = [];
  private readonly _allSighashes: InputSighash[] = [];

  constructor(
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    untweakedPublicKey: Uint8Array,
  ) {
    this.tweakedPublicKey = tweakedPublicKey;
    this.internalXOnly = internalXOnly;
    this.publicKey = untweakedPublicKey;
  }

  get calls(): readonly CapturedCall[] {
    return this._calls;
  }

  get allSighashes(): readonly InputSighash[] {
    return this._allSighashes;
  }

  /**
   * Wallet-mode signing entry point. For each PSBT, walks every taproot
   * input, classifies as script-path or key-path, signs with a dummy
   * 64-zero sig, and records the sighash the SDK passes in.
   *
   * Dummy sigs pass SDK finalization (which doesn't BIP-340-verify
   * during construction) so `sendRawTransaction(Package)` is reached
   * with a finalized template tx — at which point `CapturingProvider`
   * intercepts and throws `__capture_only__`.
   */
  async multiSignPsbt(transactions: Psbt[]): Promise<void> {
    for (const psbt of transactions) {
      const callSighashes: InputSighash[] = [];
      for (let i = 0; i < psbt.data.inputs.length; i++) {
        const input = psbt.data.inputs[i];
        if (!input || !isTaprootInput(input)) continue;

        const tapLeafScript = (input as Record<string, unknown>).tapLeafScript as unknown[] | undefined;
        const isScriptPath = !!tapLeafScript && tapLeafScript.length > 0;
        const tapInternalKey = (input as Record<string, unknown>).tapInternalKey as Uint8Array | undefined;
        const isKeyPath = !isScriptPath
          && !!tapInternalKey
          && equals(tapInternalKey, this.internalXOnly);

        if (!isScriptPath && !isKeyPath) continue;

        let capturedHash: Uint8Array | undefined;
        const dummySigner = {
          publicKey: isScriptPath ? this.publicKey : this.tweakedPublicKey,
          signSchnorr: (hash: Uint8Array) => {
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
        this._allSighashes.push(info);
      }
      this._calls.push({ sighashes: callSighashes });
    }
  }
}
