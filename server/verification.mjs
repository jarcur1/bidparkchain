import { ethers } from 'ethers';
import { readSession } from './auth.mjs';
import { aliasKeys, matchKind } from './duplicates.mjs';

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
const MAX_APPEAL = 500;

/**
 * Records a registered listing's alias keys and flags the space against other hosts' spaces that share
 * one: a system `report` entry on both spaces' audit trails, once per pair. Returns the matched spaces
 * for the warning to the host. No state change and nothing blocks the listing.
 */
export function flagDuplicates(db, contract, spaceId, host, metadata) {
  const matches = new Map();
  for (const { spaceId: other, key } of db.recordSpaceAliases(contract, spaceId, host, aliasKeys(metadata))) {
    matches.set(other, [...(matches.get(other) ?? []), matchKind(key)]);
  }
  for (const [other, kinds] of matches) {
    const how = [...new Set(kinds)].join(' and ');
    for (const [id, peer] of [[spaceId, other], [other, spaceId]]) {
      const text = `Possible duplicate of space #${peer} (same ${how})`;
      if (db.getVerificationAudit(contract, id).some((e) => e.action === 'report' && e.actor === 'system' && e.note === text)) continue;
      db.recordVerification(contract, id, {
        action: 'report', status: db.getVerification(contract, id)?.status ?? 'unverified',
        actor: 'system', reason: 'duplicate-listing', note: text,
      });
    }
  }
  return [...matches].map(([id, kinds]) => ({ spaceId: id, match: [...new Set(kinds)] }));
}

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
 *   readSpaceOwnership: (spaceId: string) => Promise<{owner: string, epoch: string}> }} deps
 */
export function mountVerification(app, { db, moderators, contractAddress, readSpaceOwnership }) {
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
      let ownership;
      try { ownership = await readSpaceOwnership(spaceId); } catch {
        return res.status(503).json({ error: 'Blockchain service unavailable' });
      }
      if (ownership.owner.toLowerCase() !== s.session.address.toLowerCase()) {
        return res.status(403).json({ error: "Only the space's on-chain owner can request verification" });
      }
      // Read after the chain call: nothing else can interleave between this check and the write.
      const current = db.getVerification(s.contract, spaceId);
      const sameHost = current && current.host.toLowerCase() === s.session.address.toLowerCase();
      if (sameHost && current.ownership_epoch === ownership.epoch && ['pending', 'approved'].includes(current.status)) {
        return res.status(409).json({ error: `This space is already ${current.status}` });
      }
      db.recordVerification(s.contract, spaceId, {
        action: 'submit', status: 'pending', actor: s.session.address, host: s.session.address, evidence,
        reason: sameHost ? 're-review' : 'initial-request', epoch: ownership.epoch,
      });
      res.status(201).json({ spaceId, status: 'pending', audit: audit(db, s.contract, spaceId, { reports: false }) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/spaces/:spaceId/appeal { note }: the host of a rejected or suspended space answers the decision.
   * Stored in the audit trail for moderators; one per decision. Re-review still needs new proof.
   */
  app.post('/api/spaces/:spaceId/appeal', (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const spaceId = spaceIdOf(req.params.spaceId);
    const text = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!spaceId) return res.status(400).json({ error: 'Valid space id is required' });
    if (text.length < 10 || text.length > MAX_APPEAL) {
      return res.status(400).json({ error: `Appeal note must be 10 to ${MAX_APPEAL} characters` });
    }
    const current = db.getVerification(s.contract, spaceId);
    if (!current || current.host.toLowerCase() !== s.session.address.toLowerCase()) {
      return res.status(403).json({ error: 'Only the host of this verification request can appeal' });
    }
    if (!['rejected', 'suspended'].includes(current.status)) {
      return res.status(409).json({ error: 'Only a rejected or suspended space can be appealed' });
    }
    const lastDecision = db.getVerificationAudit(s.contract, spaceId).filter((e) => e.action !== 'report').at(-1);
    if (lastDecision?.action === 'appeal') return res.status(409).json({ error: 'Your appeal is already with the moderators' });
    db.recordVerification(s.contract, spaceId, {
      action: 'appeal', status: current.status, actor: s.session.address, reason: 'host-appeal', note: text,
    });
    res.status(201).json({ spaceId, status: current.status, audit: audit(db, s.contract, spaceId, { reports: false }) });
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
      try { ({ owner } = await readSpaceOwnership(spaceId)); } catch {
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

  /** GET /api/moderation/verifications?limit&offset: a page of the review queue with evidence and full history. Moderators only. */
  app.get('/api/moderation/verifications', (req, res) => {
    const s = scope(req, res, { moderator: true });
    if (!s) return;
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const total = db.countModerationQueue(s.contract);
    res.json({
      reasons: REASONS,
      total,
      nextOffset: offset + limit < total ? offset + limit : null,
      queue: db.getModerationQueue(s.contract, { limit, offset }).map((row) => ({
        spaceId: row.space_id, host: row.host ?? null, status: row.status ?? 'unverified',
        epoch: row.ownership_epoch ?? null,
        evidence: row.evidence ?? '', updatedAt: row.updated_at ?? null,
        audit: audit(db, s.contract, row.space_id, { reports: true }),
      })),
    });
  });

  /** The current audited decision for one space. No evidence, signing, or state changes. */
  app.get('/api/moderation/verifications/:spaceId/attestation', (req, res) => {
    const s = scope(req, res, { moderator: true });
    if (!s) return;
    const spaceId = spaceIdOf(req.params.spaceId);
    const current = spaceId && db.getVerification(s.contract, spaceId);
    if (!current) return res.status(404).json({ error: 'Verification request not found.' });
    const lastDecision = db.getVerificationAudit(s.contract, spaceId)
      .findLast((entry) => entry.action === 'approve' || entry.action === 'revoke');
    const action = current.status === 'approved' ? 'approve' : lastDecision?.action === 'revoke' ? 'revoke' : null;
    res.set('Cache-Control', 'no-store');
    res.json({ contractAddress: s.contract, reviewer: s.session.address, host: current.host, epoch: current.ownership_epoch, action });
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
