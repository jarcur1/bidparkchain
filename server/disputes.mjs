import { ethers } from 'ethers';
import { readSession } from './auth.mjs';

/**
 * Restricted review channel for protected-booking reports (docs/booking-policy.md). The reporting party
 * submits evidence text or links and a resolver submits a decision reason; both are stored here, never
 * on-chain, and the on-chain call carries only the record's reference (a hash). Records are append-only,
 * and every submission and read is appended to an audit log. Only the booking's winner and host and
 * resolvers the contract authorizes can read them; each check reads the chain, not the session alone.
 */
export const REPORT_WINDOW = 24 * 3600;
export const RESOLUTION_WINDOW = 72 * 3600;
const MAX_TEXT = 2000;

/** The opaque on-chain reference of a record: a hash over everything in it, so it can be recomputed. */
export function disputeReference({ chainId, contract, auctionId, kind, author, uphold, body, createdAt }) {
  return ethers.id(JSON.stringify(['bidpark-dispute', 1, chainId, contract.toLowerCase(), auctionId, kind, author.toLowerCase(), uphold, body, createdAt]));
}

const idOf = (raw) => (/^[1-9]\d{0,77}$/.test(String(raw)) ? String(raw) : null);
/** A query value that is a plain non-negative decimal integer within the safe range, else null. */
const queryInt = (raw) => (typeof raw === 'string' && /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * @param {import('express').Express} app
 * @param {{ db: any, chainId: number, contractAddress: () => string | null,
 *   readState: (id: string) => Promise<object | null>, isResolver: (account: string) => Promise<boolean>,
 *   now: () => Promise<number>, sync: () => Promise<unknown> }} deps
 *   readState returns the live booking: owner, spaceOwner, highestBidder, settled, cancelled, parkingEnd,
 *   isProtected, outcome, disputeReporter, disputeEvidence; null when the auction does not exist.
 */
export function mountDisputes(app, { db, chainId, contractAddress, readState, isResolver, now, sync }) {
  const isParty = (state, account) =>
    same(state.highestBidder, account) || same(state.owner, account) || same(state.spaceOwner, account);
  const noReport = (state) => state.disputeReporter === ethers.ZeroAddress;

  /** Session, deployment and (with an :id) live state for a route, or null after answering. */
  async function scope(req, res, { auction = true } = {}) {
    const session = readSession(db, req);
    if (!session) return void res.status(401).json({ error: 'Sign in with your wallet first' });
    const contract = contractAddress();
    if (!contract) return void res.status(503).json({ error: 'Smart contract not deployed' });
    if (!auction) return { session, contract };
    const id = idOf(req.params.id);
    if (!id) return void res.status(400).json({ error: 'Valid auction id is required' });
    let state;
    let resolver;
    try {
      state = await readState(id);
      resolver = await isResolver(session.address);
    } catch {
      return void res.status(503).json({ error: 'Blockchain service unavailable' });
    }
    if (!state) return void res.status(404).json({ error: `Auction ${id} does not exist` });
    if (!state.isProtected) return void res.status(409).json({ error: 'This booking is not protected' });
    return { session, contract, id, state, resolver };
  }

  function text(req, res, field) {
    const value = typeof req.body?.[field] === 'string' ? req.body[field].trim() : '';
    if (value.length >= 10 && value.length <= MAX_TEXT) return value;
    res.status(400).json({ error: `${field} must be 10 to ${MAX_TEXT} characters` });
    return null;
  }

  function store(s, kind, body, uphold = null) {
    const createdAt = Date.now();
    const author = s.session.address;
    const reference = disputeReference({ chainId, contract: s.contract, auctionId: s.id, kind, author, uphold, body, createdAt });
    db.addDisputeRecord(s.contract, s.id, { kind, author, uphold, body, reference, createdAt });
    return { reference, createdAt };
  }

  /** POST /api/auctions/:id/dispute/evidence { text }: the winner or host stores evidence before reporting on-chain. */
  app.post('/api/auctions/:id/dispute/evidence', async (req, res, next) => {
    try {
      const s = await scope(req, res);
      if (!s) return;
      const body = text(req, res, 'text');
      if (body === null) return;
      const { state } = s;
      if (!isParty(state, s.session.address)) return res.status(403).json({ error: 'Only the winner or host can report a seller failure' });
      if (!state.settled || state.cancelled || state.outcome !== 0) return res.status(409).json({ error: 'This booking has no settled principal left to report on' });
      if (!noReport(state)) return res.status(409).json({ error: 'A report is already open for this booking' });
      if (await now() >= state.parkingEnd + REPORT_WINDOW) return res.status(409).json({ error: 'The report window has closed' });
      res.status(201).json(store(s, 'report', body));
    } catch (err) { next(err); }
  });

  /** POST /api/auctions/:id/dispute/decision { uphold, reason }: a resolver stores the reason before deciding on-chain. */
  app.post('/api/auctions/:id/dispute/decision', async (req, res, next) => {
    try {
      const s = await scope(req, res);
      if (!s) return;
      const { state } = s;
      if (!s.resolver) return res.status(403).json({ error: 'Only an authorized resolver can decide reports' });
      if (isParty(state, s.session.address)) return res.status(403).json({ error: 'A resolver cannot decide a report on their own booking' });
      if (typeof req.body?.uphold !== 'boolean') return res.status(400).json({ error: 'uphold must be true or false' });
      const body = text(req, res, 'reason');
      if (body === null) return;
      if (noReport(state) || state.cancelled) return res.status(409).json({ error: 'There is no open report to decide' });
      if (await now() >= state.parkingEnd + RESOLUTION_WINDOW) return res.status(409).json({ error: 'The resolution window has closed; the report can only expire' });
      res.status(201).json(store(s, 'decision', body, req.body.uphold));
    } catch (err) { next(err); }
  });

  /** GET /api/auctions/:id/dispute: the review record and audit trail, for the winner, host and resolvers only. */
  app.get('/api/auctions/:id/dispute', async (req, res, next) => {
    try {
      const s = await scope(req, res);
      if (!s) return;
      const { state, session } = s;
      if (!isParty(state, session.address) && !s.resolver) return res.status(403).json({ error: 'Only the parties and resolvers can read this record' });
      db.addDisputeAudit(s.contract, s.id, session.address, 'view');
      res.json({
        open: !noReport(state),
        reporter: noReport(state) ? null : state.disputeReporter,
        openReference: state.disputeEvidence === ethers.ZeroHash ? null : state.disputeEvidence,
        records: db.getDisputeRecords(s.contract, s.id).map((r) => ({
          id: r.id, kind: r.kind, author: r.author, uphold: r.uphold === null ? null : Boolean(r.uphold),
          body: r.body, reference: r.reference, createdAt: r.created_at,
        })),
        audit: db.getDisputeAudit(s.contract, s.id).map((a) => ({ actor: a.actor, action: a.action, recordId: a.record_id, at: a.at })),
      });
    } catch (err) { next(err); }
  });

  /**
   * GET /api/disputes/queue?limit&after: a page of open reports with their deadlines and the action that applies,
   * for resolvers only. Pages are keyset pages in auction id order (`after` is the last auction id seen, `nextAfter` the cursor for the next page,
   * null at the end); chain state is read for the rows on the page alone.
   */
  app.get('/api/disputes/queue', async (req, res, next) => {
    try {
      const s = await scope(req, res, { auction: false });
      if (!s) return;
      let resolver;
      try { resolver = await isResolver(s.session.address); } catch {
        return res.status(503).json({ error: 'Blockchain service unavailable' });
      }
      if (!resolver) return res.status(403).json({ error: 'Resolvers only' });
      const limit = req.query.limit === undefined ? 25 : queryInt(req.query.limit);
      const after = req.query.after === undefined ? -1 : queryInt(req.query.after);
      if (limit === null || limit < 1 || limit > 100) return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
      if (after === null) return res.status(400).json({ error: 'after must be a non-negative integer auction id' });
      await sync();
      const nowSec = await now();
      const items = [];
      const candidates = db.getOpenDisputeAuctions(s.contract, { limit: limit + 1, after });
      const more = candidates.length > limit;
      const page = candidates.slice(0, limit);
      for (const id of page) {
        const state = await readState(id);
        if (!state || noReport(state) || state.cancelled) continue;
        const resolveBy = state.parkingEnd + RESOLUTION_WINDOW;
        items.push({
          auctionId: id, title: db.getListing(id, s.contract)?.title ?? null, reporter: state.disputeReporter,
          parkingEnd: state.parkingEnd, resolveBy,
          hasRecord: db.getDisputeRecords(s.contract, id).some((r) => r.reference === state.disputeEvidence),
          isParty: isParty(state, s.session.address),
          action: nowSec >= resolveBy ? 'expireDispute' : 'resolveDispute',
        });
      }
      // The cursor follows the indexed candidates, not the rows kept after the chain check, so filtered rows never stall paging.
      res.json({ nextAfter: more ? page[page.length - 1] : null, items });
    } catch (err) { next(err); }
  });
}
