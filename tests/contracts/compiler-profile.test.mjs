import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import hre from 'hardhat';
import solc from 'solc';
import { compileEscrowContract } from '../../scripts/helpers/compiler.mjs';

const sourceName = 'project/contracts/ParkingAuctionEscrow.sol';
const contractName = 'ParkingAuctionEscrow';
const expectedSettings = {
  evmVersion: 'shanghai',
  optimizer: { enabled: true, runs: 200 },
};

describe('escrow compiler profile', () => {
  it('pins the installed compiler and resolved Hardhat configuration', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const artifact = compileEscrowContract();
    const compilers = hre.config.solidity.profiles.default.compilers;

    expect(packageJson.dependencies.solc).toBe('0.8.38');
    expect(solc.version()).toMatch(/^0\.8\.38\+/);
    expect(artifact.compilerVersion).toBe(solc.version());
    expect(compilers).toHaveLength(1);
    expect(compilers[0].version).toBe('0.8.38');
    expect(compilers[0].settings).toMatchObject(expectedSettings);
    expect(hre.config.solidity.profiles.default.overrides).toEqual({});
    expect(artifact.input.language).toBe('Solidity');
    expect(Object.keys(artifact.input.sources)).toEqual([sourceName]);
    expect(artifact.input.sources[sourceName].content).toBe(
      readFileSync(new URL('../../contracts/ParkingAuctionEscrow.sol', import.meta.url), 'utf8'),
    );
    expect(artifact.input.settings).toMatchObject(expectedSettings);
    expect(artifact.input.settings.remappings).toEqual([]);
  });

  it('matches bytecode compiled from Hardhat logical source and build settings', () => {
    const deployment = compileEscrowContract();
    const hardhatInput = {
      language: 'Solidity',
      sources: {
        [sourceName]: {
          content: readFileSync(new URL('../../contracts/ParkingAuctionEscrow.sol', import.meta.url), 'utf8'),
        },
      },
      settings: {
        ...expectedSettings,
        remappings: [],
        outputSelection: {
          '*': {
            '': ['ast'],
            '*': [
              'abi',
              'evm.bytecode.linkReferences',
              'evm.bytecode.object',
              'evm.bytecode.opcodes',
              'evm.bytecode.sourceMap',
              'evm.deployedBytecode.immutableReferences',
              'evm.deployedBytecode.linkReferences',
              'evm.deployedBytecode.object',
              'evm.deployedBytecode.opcodes',
              'evm.deployedBytecode.sourceMap',
              'evm.methodIdentifiers',
            ],
          },
        },
      },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(hardhatInput)));
    expect((output.errors ?? []).filter((error) => error.severity === 'error')).toEqual([]);
    const hardhatContract = output.contracts[sourceName][contractName];
    expect(deployment.bytecode).toBe(`0x${hardhatContract.evm.bytecode.object}`);
    expect(deployment.runtimeBytecode).toBe(`0x${hardhatContract.evm.deployedBytecode.object}`);
  });

  it('reproduces deployment runtime bytecode from explorer standard JSON input', () => {
    const deployment = compileEscrowContract();
    const repeat = compileEscrowContract();
    const explorerInput = JSON.parse(JSON.stringify(deployment.input));
    const output = JSON.parse(solc.compile(JSON.stringify(explorerInput)));
    const errors = (output.errors ?? []).filter((error) => error.severity === 'error');

    expect(errors).toEqual([]);
    const explorerRuntime = `0x${output.contracts[sourceName][contractName].evm.deployedBytecode.object}`;
    expect(deployment.bytecode).toMatch(/^0x[0-9a-f]+$/i);
    expect(deployment.runtimeBytecode).toMatch(/^0x[0-9a-f]+$/i);
    expect(ethers.keccak256(repeat.runtimeBytecode)).toBe(ethers.keccak256(deployment.runtimeBytecode));
    expect(ethers.keccak256(explorerRuntime)).toBe(ethers.keccak256(deployment.runtimeBytecode));
  });
});
