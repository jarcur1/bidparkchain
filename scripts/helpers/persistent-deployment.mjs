import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { compileEscrowContract } from './compiler.mjs';

const CHAIN_ID = 11155111;
const DEMO_PHRASE = 'test test test test test test test test test test test junk';

function requireMatch(condition, message) {
  if (!condition) throw new Error(`Invalid persistent deployment: ${message}`);
}

/** Verify a descriptor against the canonical finalized Sepolia chain and the local compiler. */
export async function verifyPersistentDeployment(provider, descriptor, artifact = compileEscrowContract(), finalizedBlock = undefined) {
  const chainId = await provider.send('eth_chainId', []);
  requireMatch(BigInt(chainId) === BigInt(CHAIN_ID), 'wrong RPC chain');
  requireMatch(descriptor && descriptor.profile === 'sepolia' && descriptor.chainId === CHAIN_ID, 'wrong descriptor profile or chain');
  requireMatch(descriptor.currency === 'ETH' && descriptor.networkName === 'Ethereum Sepolia', 'wrong descriptor network');
  requireMatch(ethers.isAddress(descriptor.contractAddress), 'invalid contract address');
  requireMatch(ethers.isHexString(descriptor.deploymentTxHash, 32), 'invalid transaction hash');
  requireMatch(Number.isSafeInteger(descriptor.deploymentBlock) && descriptor.deploymentBlock >= 0, 'invalid deployment block');
  requireMatch(ethers.isHexString(descriptor.deploymentBlockHash, 32), 'invalid deployment block hash');
  requireMatch(descriptor.compilerVersion === artifact.compilerVersion, 'compiler identity mismatch');

  // Always retrieve the actual finalized tip, even when a caller supplies a snapshot.
  const actualFinalized = await provider.getBlock('finalized');
  requireMatch(actualFinalized && Number.isSafeInteger(actualFinalized.number), 'finalized tip unavailable');
  const finalized = finalizedBlock === undefined ? actualFinalized : finalizedBlock;
  requireMatch(finalized && Number.isSafeInteger(finalized.number) && finalized.number <= actualFinalized.number, 'invalid finalized snapshot');
  const finalizedCanonical = await provider.getBlock(finalized.number);
  requireMatch(finalizedCanonical && finalized.hash && finalizedCanonical.hash?.toLowerCase() === finalized.hash.toLowerCase(), 'noncanonical finalized snapshot');
  requireMatch(descriptor.deploymentBlock <= finalized.number, 'deployment is not finalized');

  const receipt = await provider.getTransactionReceipt(descriptor.deploymentTxHash);
  requireMatch(receipt && receipt.status === 1 && receipt.to === null, 'missing or failed creation receipt');
  requireMatch(receipt.hash?.toLowerCase() === descriptor.deploymentTxHash.toLowerCase(), 'receipt transaction hash mismatch');
  requireMatch(receipt.contractAddress && receipt.contractAddress.toLowerCase() === descriptor.contractAddress.toLowerCase(), 'creation address mismatch');
  requireMatch(receipt.blockNumber === descriptor.deploymentBlock && receipt.blockHash?.toLowerCase() === descriptor.deploymentBlockHash.toLowerCase(), 'receipt block mismatch');
  const block = await provider.getBlock(receipt.blockNumber);
  requireMatch(block && block.hash?.toLowerCase() === receipt.blockHash.toLowerCase(), 'deployment block is not canonical');
  requireMatch(block.transactions.some((hash) => typeof hash === 'string' && hash.toLowerCase() === descriptor.deploymentTxHash.toLowerCase()), 'transaction not included in deployment block');
  const transaction = await provider.getTransaction(descriptor.deploymentTxHash);
  requireMatch(transaction && transaction.hash?.toLowerCase() === descriptor.deploymentTxHash.toLowerCase(), 'missing or mismatched creation transaction');
  requireMatch(transaction.blockNumber === descriptor.deploymentBlock && transaction.blockHash?.toLowerCase() === descriptor.deploymentBlockHash.toLowerCase(), 'transaction block mismatch');
  requireMatch(transaction.to === null && transaction.chainId === BigInt(CHAIN_ID) && transaction.data?.toLowerCase() === artifact.bytecode.toLowerCase(), 'creation input or chain mismatch');
  requireMatch(transaction.from?.toLowerCase() === receipt.from?.toLowerCase(), 'creation sender mismatch');
  const code = await provider.send('eth_getCode', [descriptor.contractAddress, { blockHash: finalized.hash, requireCanonical: true }]);
  requireMatch(typeof code === 'string' && code.toLowerCase() === artifact.runtimeBytecode.toLowerCase(), 'runtime bytecode mismatch');
  return {
    profile: 'sepolia', chainId: CHAIN_ID, contractAddress: descriptor.contractAddress,
    deploymentTxHash: descriptor.deploymentTxHash, deploymentBlock: descriptor.deploymentBlock,
    deploymentBlockHash: descriptor.deploymentBlockHash, compilerVersion: artifact.compilerVersion,
    currency: 'ETH', networkName: 'Ethereum Sepolia', abi: artifact.abi,
  };
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${ethers.hexlify(ethers.randomBytes(8)).slice(2)}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertNonDemoWallet(wallet) {
  for (let index = 0; index < 20; index++) {
    const demo = ethers.HDNodeWallet.fromPhrase(DEMO_PHRASE, undefined, `m/44'/60'/0'/0/${index}`);
    if (demo.address === wallet.address) throw new Error('A stock Hardhat test account cannot deploy to Sepolia.');
  }
}

/** Reuse a verified descriptor, or explicitly create/adopt a finalized deployment. */
export async function runPersistentDeployment(runtime, args = [], env = process.env) {
  if (runtime.profile.id !== 'sepolia') throw new Error('Persistent deployment requires the Sepolia profile.');
  const create = args.length === 1 && args[0] === '--create';
  const adopt = args.length === 2 && args[0] === '--adopt' && ethers.isHexString(args[1], 32);
  const resume = args.length === 1 && args[0] === '--resume';
  if (args.length && !create && !adopt && !resume) throw new Error('Use --create, --resume or --adopt <transaction hash>.');
  const provider = new ethers.JsonRpcProvider(runtime.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
  const artifact = compileEscrowContract();
  const descriptorPath = runtime.deploymentPath;
  const readExisting = async () => verifyPersistentDeployment(provider, JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), artifact);
  if (fs.existsSync(descriptorPath)) return await readExisting();
  if (!create && !adopt && !resume) throw new Error('No persistent deployment exists. Explicitly use --create, --resume or --adopt <transaction hash>.');

  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const lockPath = `${descriptorPath}.lock`;
  const pendingPath = `${descriptorPath}.pending`;
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Deployment is locked. Resolve the other process or a stale lock before retrying.');
    throw error;
  }
  try {
    if (fs.existsSync(descriptorPath)) return await readExisting();
    let hash;
    if (create) {
      if (fs.existsSync(pendingPath)) throw new Error('A creation is journaled. Recover it with --resume or --adopt; do not create another.');
      requireMatch(BigInt(await provider.send('eth_chainId', [])) === BigInt(CHAIN_ID), 'wrong RPC chain');
      const finalized = await provider.getBlock('finalized');
      requireMatch(finalized && Number.isSafeInteger(finalized.number) && ethers.isHexString(finalized.hash, 32), 'finalized tip unavailable');
      const canonical = await provider.getBlock(finalized.number);
      requireMatch(canonical?.hash?.toLowerCase() === finalized.hash.toLowerCase(), 'noncanonical finalized tip');
      let wallet;
      try { wallet = new ethers.Wallet(env.BIDPARK_SEPOLIA_DEPLOYER_KEY, provider); } catch { throw new Error('A valid BIDPARK_SEPOLIA_DEPLOYER_KEY is required.'); }
      assertNonDemoWallet(wallet);
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
      const request = await wallet.populateTransaction(await factory.getDeployTransaction());
      requireMatch(request.chainId !== undefined && BigInt(request.chainId) === BigInt(CHAIN_ID), 'wrong transaction chain');
      requireMatch(BigInt(await provider.send('eth_chainId', [])) === BigInt(CHAIN_ID), 'wrong RPC chain');
      const signed = await wallet.signTransaction(request);
      hash = ethers.keccak256(signed);
      // Journal the signed transaction before broadcasting so an interrupted send can be resumed.
      writeAtomic(pendingPath, { deploymentTxHash: hash, signedTransaction: signed });
      await provider.broadcastTransaction(signed);
    } else if (resume) {
      if (!fs.existsSync(pendingPath)) throw new Error('No pending creation is available to resume.');
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      requireMatch(ethers.isHexString(pending.deploymentTxHash, 32) && typeof pending.signedTransaction === 'string', 'invalid pending creation');
      let signed;
      try { signed = ethers.Transaction.from(pending.signedTransaction); } catch { throw new Error('Invalid pending creation transaction.'); }
      hash = pending.deploymentTxHash;
      requireMatch(signed.isSigned() && signed.hash?.toLowerCase() === hash.toLowerCase() && signed.chainId === BigInt(CHAIN_ID) && signed.to === null && signed.data.toLowerCase() === artifact.bytecode.toLowerCase(), 'pending creation transaction mismatch');
      requireMatch(BigInt(await provider.send('eth_chainId', [])) === BigInt(CHAIN_ID), 'wrong RPC chain');
      if (!await provider.getTransactionReceipt(hash) && !await provider.getTransaction(hash)) {
        await provider.broadcastTransaction(pending.signedTransaction);
      }
    } else {
      hash = args[1];
      if (fs.existsSync(pendingPath)) {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        if (pending.deploymentTxHash?.toLowerCase() !== hash.toLowerCase()) throw new Error('Adoption hash does not match the pending creation.');
      }
    }
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) throw new Error(`Creation transaction ${hash} is pending; retry with --resume or --adopt after finalization.`);
    const descriptor = {
      profile: 'sepolia',
      chainId: CHAIN_ID,
      contractAddress: receipt.contractAddress,
      deploymentTxHash: hash,
      deploymentBlock: receipt.blockNumber,
      deploymentBlockHash: receipt.blockHash,
      compilerVersion: artifact.compilerVersion,
      currency: 'ETH',
      networkName: 'Ethereum Sepolia',
    };
    const verified = await verifyPersistentDeployment(provider, descriptor, artifact);
    writeAtomic(descriptorPath, verified);
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    return verified;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
  } finally {
    provider.destroy();
  }
}
