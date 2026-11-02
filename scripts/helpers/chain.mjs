import { ethers } from 'ethers';

export const HARDHAT_RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
export const HARDHAT_CHAIN_ID = 31337;
export const HARDHAT_MNEMONIC =
  process.env.DEMO_MNEMONIC || 'test test test test test test test test test test test junk';

/**
 * Returns an ethers JsonRpcProvider connected to the local node.
 * Uses cacheTimeout: -1 to prevent stale balance and nonce caching during tests.
 */
export function getProvider(rpcUrl = HARDHAT_RPC_URL) {
  return new ethers.JsonRpcProvider(
    rpcUrl,
    {
      chainId: HARDHAT_CHAIN_ID,
      name: 'hardhat',
    },
    {
      cacheTimeout: -1,
    }
  );
}

/**
 * Asserts that the connected RPC network is strictly local testnet (31337).
 * Prevents test accounts and mnemonics from ever signing transactions against non-local networks.
 */
export async function assertLocalChain(provider = getProvider()) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== HARDHAT_CHAIN_ID) {
    throw new Error(
      `Security check failed: connected chainId is ${network.chainId}, expected local testnet ${HARDHAT_CHAIN_ID}. Refusing to sign with development test mnemonic.`
    );
  }
}

/**
 * Derives a HD wallet for the given account index from the standard Hardhat mnemonic.
 * @param {number} index Account index (0 = vendor/deployer, 1 = buyer, etc.)
 * @param {ethers.Provider} [provider]
 */
export function getWallet(index = 0, provider = getProvider()) {
  const derivationPath = `m/44'/60'/0'/0/${index}`;
  const hdNode = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, derivationPath);
  return hdNode.connect(provider);
}

/**
 * Checks whether the JSON-RPC node is responsive.
 */
export async function isNodeReachable(rpcUrl = HARDHAT_RPC_URL) {
  try {
    const provider = getProvider(rpcUrl);
    const network = await provider.getNetwork();
    return Number(network.chainId) === HARDHAT_CHAIN_ID;
  } catch {
    return false;
  }
}

/**
 * Checks if deployed bytecode exists at the given address.
 */
export async function hasDeployedCode(address, provider = getProvider()) {
  if (!address || !ethers.isAddress(address)) return false;
  try {
    const code = await provider.getCode(address);
    return code !== '0x' && code.length > 2;
  } catch {
    return false;
  }
}

/**
 * Increases chain time on local node via evm_increaseTime.
 */
export async function advanceTime(seconds, provider = getProvider()) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

/**
 * Takes an EVM snapshot on local node.
 * @returns {Promise<string>} snapshot ID
 */
export async function takeSnapshot(provider = getProvider()) {
  return await provider.send('evm_snapshot', []);
}

/**
 * Reverts EVM state to a previously captured snapshot ID.
 * Strictly verifies that evm_revert returned true.
 * @param {string} snapshotId
 * @returns {Promise<boolean>}
 */
export async function revertSnapshot(snapshotId, provider = getProvider()) {
  const result = await provider.send('evm_revert', [snapshotId]);
  if (result !== true) {
    throw new Error(`evm_revert failed: provider returned ${result} for snapshot ${snapshotId}`);
  }
  return true;
}
