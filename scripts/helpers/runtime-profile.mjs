import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNetworkProfile } from '../../shared/network-profiles.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const LOCAL_DATA_DIR = path.resolve(ROOT_DIR, 'data');

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function validateRpc(value, profile) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid RPC configuration');
  }
  const loopback = isLoopback(url.hostname);
  if (url.username || url.password || url.hash ||
      (profile.id === 'local' && (!loopback || !['http:', 'https:'].includes(url.protocol))) ||
      (profile.id === 'sepolia' && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Invalid RPC configuration for network profile');
  }
  return value;
}

// Resolve existing ancestors so aliases to the local directory cannot bypass isolation.
function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const resolved = path.resolve(fs.realpathSync(current), ...suffix);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Check existing artifacts before a caller creates directories or writes data.
export function assertProfileDirectory(runtime) {
  const { dataDir, profile } = runtime;
  const descriptorPath = path.join(dataDir, 'deployment.json');
  const exists = (file) => {
    try {
      fs.lstatSync(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new Error('Unable to inspect network profile data directory');
    }
  };

  if (profile.id === 'local') {
    if (exists(path.join(dataDir, 'bidpark-sepolia.db')) ||
        exists(`${descriptorPath}.pending`) || exists(`${descriptorPath}.lock`)) {
      throw new Error('Network profile data directory contains Sepolia data');
    }
  } else if (profile.id === 'sepolia') {
    if (exists(path.join(dataDir, 'bidpark.db'))) {
      throw new Error('Network profile data directory contains local data');
    }
  } else {
    throw new Error('Unknown BidPark network profile');
  }

  if (!exists(descriptorPath)) return;
  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch {
    throw new Error('Unable to read network profile deployment descriptor');
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Invalid network profile deployment descriptor');
  }
  const descriptorProfile = descriptor.profile;
  const chainId = descriptor.chainId;
  const chainProfile = chainId === 31337 || chainId === '31337' ? 'local'
    : chainId === 11155111 || chainId === '11155111' ? 'sepolia' : null;
  if ((descriptorProfile !== undefined && !['local', 'sepolia'].includes(descriptorProfile)) ||
      (chainId !== undefined && chainProfile === null) ||
      (descriptorProfile === undefined && chainProfile === null && profile.id !== 'local') ||
      (descriptorProfile !== undefined && chainProfile !== null && descriptorProfile !== chainProfile)) {
    throw new Error('Invalid network profile deployment descriptor');
  }
  if ((descriptorProfile ?? chainProfile ?? 'local') !== profile.id) {
    throw new Error('Network profile data directory contains another profile');
  }
}

export function resolveRuntimeProfile(env = process.env) {
  const profile = getNetworkProfile(env.BIDPARK_PROFILE);
  const dataValue = env.BIDPARK_DATA_DIR;
  if (dataValue !== undefined && (typeof dataValue !== 'string' || !dataValue.trim())) {
    throw new Error('Invalid BIDPARK_DATA_DIR');
  }
  if (profile.id === 'sepolia' && dataValue === undefined) {
    throw new Error('BIDPARK_DATA_DIR is required for Sepolia');
  }
  const dataDir = dataValue === undefined ? LOCAL_DATA_DIR : path.resolve(dataValue);
  if (profile.id === 'sepolia') {
    const local = canonicalPath(LOCAL_DATA_DIR);
    const target = canonicalPath(dataDir);
    const relative = path.relative(local, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Sepolia data directory must be isolated from local data');
    }
  }
  const rpcValue = profile.id === 'local'
    ? (env.RPC_URL === undefined ? profile.walletRpcUrl : env.RPC_URL)
    : env.BIDPARK_SEPOLIA_RPC_URL;
  if (typeof rpcValue !== 'string' || !rpcValue.trim()) {
    throw new Error('RPC configuration is required for network profile');
  }
  return {
    profile,
    rpcUrl: validateRpc(rpcValue, profile),
    dataDir,
    deploymentPath: path.join(dataDir, 'deployment.json'),
    dbPath: path.join(dataDir, profile.id === 'sepolia' ? 'bidpark-sepolia.db' : 'bidpark.db'),
  };
}
