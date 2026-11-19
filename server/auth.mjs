import crypto from 'node:crypto';
import { ethers } from 'ethers';

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const SESSION_COOKIE = 'bidpark_session';
export const PROFILE_ROLES = ['driver', 'host', 'both'];

/** The page origin a request came from: the browser's Origin header, else the Host it addressed. */
export function requestOrigin(req) {
  return req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

/**
 * EIP-4361 (Sign-In with Ethereum) message. The server builds it and keeps the exact text, so the
 * signature is checked against what was issued rather than against anything the client sends back.
 */
export function signInMessage({ origin, address, chainId, nonce, issuedAt, expiresAt }) {
  const { host } = new URL(origin);
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to BidPark. This only proves you control this wallet address. It does not verify that you control any parking space, and it does not move any funds.',
    '',
    `URI: ${origin}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAgeSeconds}${secure}`;
}

/**
 * The signed-in session for this request, or null. A session only counts for the chain it was
 * created on, and only until it expires or is revoked. Browsers send Origin on every POST, so a
 * request from another origin is refused; same-origin GETs carry no Origin (and a dev proxy may
 * rewrite Host), and those are already limited to this site by the SameSite=Strict cookie.
 */
export function readSession(db, req, now = Date.now()) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = db.getSession(sha256(token));
  const origin = req.get('origin');
  if (!session || session.revoked || session.expires_at <= now || (origin && origin !== session.origin)) return null;
  return { address: session.address, chainId: session.chain_id, expiresAt: session.expires_at, tokenHash: session.token_hash };
}

/** Adds /api/auth routes: nonce, verify, session and logout. */
export function mountAuth(app, db, chainId) {
  app.post('/api/auth/nonce', (req, res) => {
    const address = req.body?.address;
    if (typeof address !== 'string' || !ethers.isAddress(address)) {
      res.status(400).json({ error: 'A valid wallet address is required' });
      return;
    }
    const origin = requestOrigin(req);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + NONCE_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = signInMessage({ origin, address: ethers.getAddress(address), chainId, nonce, issuedAt, expiresAt });
    db.createNonce({ nonce, address: ethers.getAddress(address), origin, message, expiresAt });
    res.json({ nonce, message, expiresAt });
  });

  app.post('/api/auth/verify', (req, res) => {
    const { nonce, signature } = req.body ?? {};
    const issued = typeof nonce === 'string' ? db.getNonce(nonce) : null;
    const reject = (error) => res.status(401).json({ error });
    if (!issued) return reject('Unknown sign-in request. Request a new one.');
    if (issued.used) return reject('This sign-in request was already used. Request a new one.');
    if (issued.expires_at <= Date.now()) return reject('This sign-in request expired. Request a new one.');
    if (issued.origin !== requestOrigin(req)) return reject('This sign-in request was issued for a different site.');
    let signer;
    try {
      signer = ethers.verifyMessage(issued.message, signature);
    } catch {
      return reject('The signature could not be read.');
    }
    if (signer !== issued.address) return reject('The signature does not match the wallet address.');
    if (!db.consumeNonce(nonce)) return reject('This sign-in request was already used. Request a new one.');

    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    db.createSession({ tokenHash: sha256(token), address: issued.address, origin: issued.origin, createdAt, expiresAt });
    res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)));
    res.json({ address: issued.address, chainId, expiresAt });
  });

  app.get('/api/auth/session', (req, res) => {
    const session = readSession(db, req);
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    res.json({ address: session.address, chainId: session.chainId, expiresAt: session.expiresAt });
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = readSession(db, req);
    if (session) db.revokeSession(session.tokenHash);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ signedOut: true });
  });

  // Profiles belong to the signed-in wallet only; there is no way to read or write someone else's.
  app.get('/api/profile', (req, res) => {
    const session = readSession(db, req);
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    const row = db.getProfile(session.address);
    res.json({ profile: row ? { role: row.role, displayName: row.display_name } : null });
  });

  app.post('/api/profile', (req, res) => {
    const session = readSession(db, req);
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    const { role, displayName = '' } = req.body ?? {};
    if (!PROFILE_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${PROFILE_ROLES.join(', ')}` });
    }
    if (typeof displayName !== 'string' || displayName.trim().length > 40) {
      return res.status(400).json({ error: 'Display name must be at most 40 characters' });
    }
    db.saveProfile(session.address, { role, displayName: displayName.trim() });
    res.json({ profile: { role, displayName: displayName.trim() } });
  });
}
