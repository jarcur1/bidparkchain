import { createRequire } from "node:module";
import { defineConfig } from "hardhat/config";
import { SOLIDITY_VERSION, SOLIDITY_SETTINGS } from "./scripts/helpers/compiler.mjs";

export default defineConfig({
  solidity: {
    version: SOLIDITY_VERSION,
    path: createRequire(import.meta.url).resolve("solc/soljson.js"),
    settings: SOLIDITY_SETTINGS,
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
  },
});
