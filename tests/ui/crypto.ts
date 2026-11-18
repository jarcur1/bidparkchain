import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { computeHmac, pbkdf2, sha256, sha512 } from 'ethers';

// Node crypto returns Buffers from another realm. Hex results preserve real cryptography
// without ethers mistaking those Buffers for non-byte objects in jsdom's VM.
export function bridgeCrypto() {
  computeHmac.register((algorithm, key, data) => `0x${createHmac(algorithm, key).update(data).digest('hex')}`);
  pbkdf2.register((password, salt, iterations, keylen, algorithm) => `0x${pbkdf2Sync(password, salt, iterations, keylen, algorithm).toString('hex')}`);
  sha256.register((data) => `0x${createHash('sha256').update(data).digest('hex')}`);
  sha512.register((data) => `0x${createHash('sha512').update(data).digest('hex')}`);
}
