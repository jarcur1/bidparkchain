import { getNetworkProfile } from '../../shared/network-profiles.mjs';

// Vite defines this from BIDPARK_PROFILE; only an absent value defaults to local.
export const webProfile = getNetworkProfile(import.meta.env.VITE_BIDPARK_PROFILE);
export const isLocalBuild = webProfile.id === 'local';
