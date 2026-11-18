// Public, non-secret network metadata shared by the server and browser.
export const NETWORK_PROFILES = Object.freeze({
  local: Object.freeze({
    id: 'local',
    chainId: 31337,
    networkName: 'Hardhat Local',
    currency: 'ETH',
    confirmation: 'mined',
    explorerUrl: null,
    walletRpcUrl: 'http://127.0.0.1:8545',
  }),
  sepolia: Object.freeze({
    id: 'sepolia',
    chainId: 11155111,
    networkName: 'Ethereum Sepolia',
    currency: 'ETH',
    confirmation: 'finalized',
    explorerUrl: 'https://sepolia.etherscan.io',
    walletRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  }),
});

export function getNetworkProfile(value) {
  const id = value === undefined ? 'local' : value;
  if (id !== 'local' && id !== 'sepolia') {
    throw new Error('Unknown BidPark network profile');
  }
  return NETWORK_PROFILES[id];
}
