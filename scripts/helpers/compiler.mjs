import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

/**
 * Compiles ParkingAuctionEscrow.sol using solc with Shanghai EVM target.
 * @returns {{ abi: any[], bytecode: string, contractSource: string }}
 */
export function compileEscrowContract() {
  const contractPath = path.resolve(ROOT_DIR, 'contracts/ParkingAuctionEscrow.sol');
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract file not found at ${contractPath}`);
  }

  const sourceContent = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'ParkingAuctionEscrow.sol': {
        content: sourceContent,
      },
    },
    settings: {
      evmVersion: 'shanghai',
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
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

  const contractData = output.contracts?.['ParkingAuctionEscrow.sol']?.['ParkingAuctionEscrow'];
  if (!contractData) {
    throw new Error('Contract ParkingAuctionEscrow not found in solc output');
  }

  return {
    abi: contractData.abi,
    bytecode: '0x' + contractData.evm.bytecode.object,
    contractSource: sourceContent,
  };
}
