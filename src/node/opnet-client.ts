import { networks, type Network } from '@btc-vision/bitcoin';
import { Mnemonic, MLDSASecurityLevel } from '@btc-vision/transaction';
import { JSONRpcProvider } from 'opnet';
import type { NetworkName } from './types.js';

const RPC_URLS: Record<NetworkName, string> = {
  testnet: 'https://testnet.opnet.org',
  mainnet: 'https://mainnet.opnet.org',
};

export function getNetwork(name: NetworkName): Network {
  return name === 'mainnet' ? networks.bitcoin : networks.opnetTestnet;
}

export function getProvider(networkName: NetworkName): JSONRpcProvider {
  const network = getNetwork(networkName);
  return new JSONRpcProvider({ url: RPC_URLS[networkName], network });
}

export function generateWallet(mnemonic: string, networkName: NetworkName) {
  const network = getNetwork(networkName);
  const m = new Mnemonic(mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
  const wallet = m.deriveOPWallet(undefined, 0, 0, false);
  return { mnemonic: m, wallet };
}

export function generateMnemonic(): string {
  return Mnemonic.generatePhrase();
}
