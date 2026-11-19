import crypto from 'node:crypto';

/**
 * Short-lived arrival tokens: "bp1.<base64url payload>.<base64url HMAC-SHA256>". The payload binds the
 * chain, contract, auction and winner to a random nonce and an expiry (unix seconds). The key comes from
 * BIDPARK_ARRIVAL_TOKEN_KEY; the server keeps no copy of an issued token, only the nonces already used.
 */
export const TOKEN_TTL = 5 * 60;

const mac = (key, body) => crypto.createHmac('sha256', key).update(body).digest('base64url');

export function signToken(key, { chainId, contract, auctionId, winner, expiresAt }) {
  const body = Buffer.from(JSON.stringify({
    c: chainId, k: contract.toLowerCase(), a: auctionId, w: winner.toLowerCase(),
    n: crypto.randomBytes(16).toString('base64url'), e: expiresAt,
  })).toString('base64url');
  return `bp1.${body}.${mac(key, `bp1.${body}`)}`;
}

/** The payload { chainId, contract, auctionId, winner, nonce, expiresAt } of a genuine token, else null. */
export function readToken(key, token) {
  const parts = typeof token === 'string' && token.length < 1024 ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== 'bp1') return null;
  const want = Buffer.from(mac(key, `bp1.${parts[1]}`));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { chainId: p.c, contract: p.k, auctionId: p.a, winner: p.w, nonce: p.n, expiresAt: p.e };
  } catch {
    return null;
  }
}
