import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

export const SOLIDITY_VERSION = '0.8.38';
export const SOLIDITY_SETTINGS = {
  evmVersion: 'shanghai',
  optimizer: { enabled: true, runs: 200 },
  remappings: [],
};
const SOURCE_NAME = 'project/contracts/ParkingAuctionEscrow.sol';

/**
 * Compiles the escrow using the same source name and settings as Hardhat.
 */
export function compileEscrowContract() {
  const compilerVersion = solc.version();
  if (!compilerVersion.startsWith(`${SOLIDITY_VERSION}+`)) {
    throw new Error(`Expected solc ${SOLIDITY_VERSION}, got ${compilerVersion}`);
  }
  const contractPath = path.resolve(ROOT_DIR, 'contracts/ParkingAuctionEscrow.sol');
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract file not found at ${contractPath}`);
  }

  const sourceContent = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      [SOURCE_NAME]: {
        content: sourceContent,
      },
    },
    settings: {
      ...SOLIDITY_SETTINGS,
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  };

  const outputRaw = solc.compile(JSON.stringify(input));
  const output = JSON.parse(outputRaw);

  if (output.errors) {
    const fatalErrors = output.errors.filter((err) => err.severity === 'error');
    if (fatalErrors.length > 0) {
      const errorMsg = fatalErrors.map((err) => err.formattedMessage || err.message).join('\n');
      throw new Error(`Solidity compilation failed:\n${errorMsg}`);
    }
  }

  const contractData = output.contracts?.[SOURCE_NAME]?.['ParkingAuctionEscrow'];
  if (!contractData) {
    throw new Error('Contract ParkingAuctionEscrow not found in solc output');
  }

  return {
    abi: contractData.abi,
    bytecode: '0x' + contractData.evm.bytecode.object,
    runtimeBytecode: '0x' + contractData.evm.deployedBytecode.object,
    compilerVersion,
    input,
    contractSource: sourceContent,
  };
}
