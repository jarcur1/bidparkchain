import { ethers } from 'ethers';
import { readSession } from './auth.mjs';

/**
 * Host space-control verification. A space's on-chain owner asks for review with private evidence;
 * moderators (BIDPARK_MODERATORS) approve, reject or revoke with a reason code; anyone signed in can
 * report a space. Every step is appended to the audit log. Evidence is only ever returned to
 * moderators, is cleared when a request is rejected or revoked, and is never logged.
 */
export const REASONS = {
  approve: ['control-verified'],
  reject: ['insufficient-evidence', 'not-space-controller', 'duplicate-listing', 'fraudulent-listing'],
  revoke: ['control-lost', 'duplicate-listing', 'fraudulent-listing', 'policy-violation', 'host-request'],
  report: ['duplicate-listing', 'fraudulent-listing', 'not-space-controller'],
};
/** Which state each moderator action applies to, and the state it leads to. */
const TRANSITIONS = {
  approve: { from: 'pending', to: 'approved' },
  reject: { from: 'pending', to: 'rejected' },
  revoke: { from: 'approved', to: 'suspended' },
};
const MAX_EVIDENCE = 2000;
const MAX_NOTE = 280;

/** Public meaning of a listing's verification: only an approved request by the current owner counts. */
export function publicVerification(row, owner) {
  return row?.status === 'approved' && row.host.toLowerCase() === owner.toLowerCase() ? 'verified' : 'unverified';
}

/** Parses a moderator allowlist: comma-separated wallet addresses. Throws on any invalid entry. */
export function parseModerators(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  return new Set(list.map((address) => {
    if (!ethers.isAddress(address)) throw new Error(`Invalid moderator address: ${address}`);
    return address.toLowerCase();
  }));
}

const spaceIdOf = (raw) => (/^[1-9]\d{0,77}$/.test(String(raw)) ? String(raw) : null);
const audit = (db, contract, spaceId, { reports }) => db.getVerificationAudit(contract, spaceId)
  .filter((entry) => reports || entry.action !== 'report');

/**
 * @param {import('express').Express} app
 * @param {{ db: any, moderators: Set<string>, contractAddress: () => string | null,
 *   readSpaceOwner: (spaceId: string) => Promise<string> }} deps
 */
export function mountVerification(app, { db, moderators, contractAddress, readSpaceOwner }) {
  const isModerator = (session) => moderators.has(session.address.toLowerCase());

  /** Session and deployment for a verification route, or null after answering. */
  function scope(req, res, { moderator = false } = {}) {
    const session = readSession(db, req);
    if (!session) return void res.status(401).json({ error: 'Sign in with your wallet first' });
    if (moderator && !isModerator(session)) return void res.status(403).json({ error: 'Moderators only' });
    const contract = contractAddress();
    if (!contract) return void res.status(503).json({ error: 'Smart contract not deployed' });
    return { session, contract };
  }

  function note(req, res) {
    const value = req.body?.note ?? '';
    if (typeof value === 'string' && value.trim().length <= MAX_NOTE) return value.trim();
    res.status(400).json({ error: `Note must be at most ${MAX_NOTE} characters` });
    return null;
  }

  /** GET /api/verifications/mine: the signed-in host's requests and their history (no evidence). */
  app.get('/api/verifications/mine', (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    res.json({
      moderator: isModerator(s.session),
      verifications: db.getHostVerifications(s.contract, s.session.address).map((row) => ({
        spaceId: row.space_id, status: row.status, updatedAt: row.updated_at,
        audit: audit(db, s.contract, row.space_id, { reports: false }),
      })),
    });
  });

  /** POST /api/spaces/:spaceId/verification { evidence }: the space's on-chain owner asks for review. */
  app.post('/api/spaces/:spaceId/verification', async (req, res, next) => {
    try {
      const s = scope(req, res);
      if (!s) return;
      const spaceId = spaceIdOf(req.params.spaceId);
      if (!spaceId) return res.status(400).json({ error: 'Valid space id is required' });
      const evidence = typeof req.body?.evidence === 'string' ? req.body.evidence.trim() : '';
      if (evidence.length < 10 || evidence.length > MAX_EVIDENCE) {
        return res.status(400).json({ error: `Describe your proof of control in 10 to ${MAX_EVIDENCE} characters` });
      }
      let owner;
      try { owner = await readSpaceOwner(spaceId); } catch {
        return res.status(503).json({ error: 'Blockchain service unavailable' });
      }
      if (owner.toLowerCase() !== s.session.address.toLowerCase()) {
        return res.status(403).json({ error: "Only the space's on-chain owner can request verification" });
      }
      // Read after the chain call: nothing else can interleave between this check and the write.
      const current = db.getVerification(s.contract, spaceId);
      const sameHost = current && current.host.toLowerCase() === s.session.address.toLowerCase();
      if (sameHost && ['pending', 'approved'].includes(current.status)) {
        return res.status(409).json({ error: `This space is already ${current.status}` });
      }
      db.recordVerification(s.contract, spaceId, {
        action: 'submit', status: 'pending', actor: s.session.address, host: s.session.address, evidence,
        reason: sameHost ? 're-review' : 'initial-request',
      });
      res.status(201).json({ spaceId, status: 'pending', audit: audit(db, s.contract, spaceId, { reports: false }) });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/spaces/:spaceId/report { reason, note }: any signed-in wallet flags a space for moderators. */
  app.post('/api/spaces/:spaceId/report', async (req, res, next) => {
    try {
      const s = scope(req, res);
      if (!s) return;
      const spaceId = spaceIdOf(req.params.spaceId);
      if (!spaceId) return res.status(400).json({ error: 'Valid space id is required' });
      if (!REASONS.report.includes(req.body?.reason)) {
        return res.status(400).json({ error: `Reason must be one of: ${REASONS.report.join(', ')}` });
      }
      const text = note(req, res);
      if (text === null) return;
      let owner;
      try { owner = await readSpaceOwner(spaceId); } catch {
        return res.status(503).json({ error: 'Blockchain service unavailable' });
      }
      if (owner === ethers.ZeroAddress) return res.status(404).json({ error: `Space ${spaceId} does not exist` });
      const current = db.getVerification(s.contract, spaceId);
      db.recordVerification(s.contract, spaceId, {
        action: 'report', status: current?.status ?? 'unverified', actor: s.session.address, reason: req.body.reason, note: text,
      });
      res.status(201).json({ reported: true });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/moderation/verifications: the review queue with evidence and full history. Moderators only. */
  app.get('/api/moderation/verifications', (req, res) => {
    const s = scope(req, res, { moderator: true });
    if (!s) return;
    res.json({
      reasons: REASONS,
      queue: db.getModerationQueue(s.contract).map((row) => ({
        spaceId: row.space_id, host: row.host ?? null, status: row.status ?? 'unverified',
        evidence: row.evidence ?? '', updatedAt: row.updated_at ?? null,
        audit: audit(db, s.contract, row.space_id, { reports: true }),
      })),
    });
  });

  /** POST /api/moderation/verifications/:spaceId { action, reason, note }: approve, reject or revoke. */
  app.post('/api/moderation/verifications/:spaceId', (req, res) => {
    const s = scope(req, res, { moderator: true });
    if (!s) return;
    const spaceId = spaceIdOf(req.params.spaceId);
    const { action, reason } = req.body ?? {};
    const transition = TRANSITIONS[action];
    if (!spaceId || !transition) return res.status(400).json({ error: 'Valid space id and action (approve, reject, revoke) are required' });
    if (!REASONS[action].includes(reason)) {
      return res.status(400).json({ error: `Reason must be one of: ${REASONS[action].join(', ')}` });
    }
    const text = note(req, res);
    if (text === null) return;
    const current = db.getVerification(s.contract, spaceId);
    if (!current || current.status !== transition.from) {
      return res.status(409).json({ error: `Only a ${transition.from} space can be ${transition.to}` });
    }
    if (current.host.toLowerCase() === s.session.address.toLowerCase()) {
      return res.status(403).json({ error: 'Moderators cannot decide on their own spaces' });
    }
    db.recordVerification(s.contract, spaceId, {
      action, status: transition.to, actor: s.session.address, reason, note: text,
      evidence: transition.to === 'approved' ? undefined : null,
    });
    res.json({ spaceId, status: transition.to, audit: audit(db, s.contract, spaceId, { reports: true }) });
  });
}
