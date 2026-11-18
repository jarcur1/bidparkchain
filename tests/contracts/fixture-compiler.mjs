import fs from 'node:fs';
import solc from 'solc';

let artifact;
export function recipientArtifact() {
  if (artifact) return artifact;
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'AdversarialRecipient.sol': { content: fs.readFileSync(new URL('./fixtures/AdversarialRecipient.sol', import.meta.url), 'utf8') } },
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const compiled = output.contracts['AdversarialRecipient.sol'].AdversarialRecipient;
  artifact = { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
  return artifact;
}
