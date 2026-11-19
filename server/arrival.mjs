import { ethers } from 'ethers';
import { readSession } from './auth.mjs';

/**
 * Private arrival instructions and winner check-in (docs/booking-policy.md#arrival-instructions-and-check-in).
 * A host (the auction's owner, or the space's owner or approved lister) stores instructions for a space or
 * for one auction. Only the settled, uncancelled winner can read them, and only from ARRIVAL_OPENS_BEFORE
 * before parking starts until parking ends. Every check is made against one pinned chain block. The text is
 * never logged and never appears in a listing, search or event response.
 */
export const ARRIVAL_OPENS_BEFORE = 60 * 60;
export const CHECK_IN_OPENS_BEFORE = 15 * 60;
export const MAX_INSTRUCTIONS = 2000;

const ID = /^[1-9]\d{0,77}$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

const DENIED = {
  'not-winner': 'Only the settled winner of this auction can do this',
  cancelled: 'This reservation was cancelled or refunded',
  unsettled: 'This opens once the auction is settled on-chain',
  'too-early': 'This is not open yet',
  closed: 'The reservation has ended',
};

/**
 * Whether `address` may see an auction's arrival details (or check in, with CHECK_IN_OPENS_BEFORE) at
 * `chainTime`: { ok: true } or { ok: false, reason, error }. Pure, so every edge is testable.
 */
export function winnerAccess({ onchain, booking, address, chainTime, opensBefore = ARRIVAL_OPENS_BEFORE }) {
  const S = Number(onchain.parkingStart);
  const E = Number(onchain.parkingEnd);
  const outcome = booking ? Number(booking.outcome) : 0;
  let reason = null;
  if (onchain.highestBidder === ethers.ZeroAddress || !same(onchain.highestBidder, address)) reason = 'not-winner';
  // Outcome 6 is HostPaid; every other non-zero outcome credited the principal back to the winner.
  else if (onchain.cancelled || (outcome !== 0 && outcome !== 6) || booking?.lateCancelled) reason = 'cancelled';
  else if (!onchain.settled) reason = 'unsettled';
  else if (chainTime < S - opensBefore) reason = 'too-early';
  else if (chainTime >= E) reason = 'closed';
  return reason ? { ok: false, reason, error: DENIED[reason] } : { ok: true };
}

/**
 * @param {import('express').Express} app
 * @param {{ db: any, requireKey?: boolean, contractAddress: () => string | null,
 *   pinnedReader: () => Promise<{ block: { number: number, hash: string, timestamp: number },
 *     call: (method: string, args: unknown[]) => Promise<any> }> }} deps
 */
export function mountArrival(app, { db, contractAddress, pinnedReader, requireKey = false }) {
  function scope(req, res) {
    const session = readSession(db, req);
    if (!session) return void res.status(401).json({ error: 'Sign in with your wallet first' });
    const contract = contractAddress();
    if (!contract) return void res.status(503).json({ error: 'Smart contract not deployed' });
    return { session, contract };
  }

  /** The auction's state at one pinned block, or null after answering. */
  async function readAuction(req, res, address) {
    const id = ID.test(req.params.id) ? req.params.id : null;
    if (!id) return void res.status(400).json({ error: 'Valid auction id is required' });
    try {
      const { block, call } = await pinnedReader();
      const onchain = await call('auctions', [id]);
      if (onchain.owner === ethers.ZeroAddress) return void res.status(404).json({ error: `Auction ${id} does not exist` });
      const [spaceId] = await call('auctionSpace', [id]);
      const [booking, [lister]] = await Promise.all([call('bookings', [id]), call('isSpaceLister', [spaceId, address])]);
      return {
        id, onchain, booking, spaceId: spaceId.toString(), block,
        isHost: same(onchain.owner, address) || lister,
        // The next block is stamped no earlier than the pinned one or the node's wall clock.
        chainTime: Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000)),
      };
    } catch {
      return void res.status(503).json({ error: 'Blockchain service unavailable' });
    }
  }

  const checkInView = (row) => row && { winner: ethers.getAddress(row.winner), checkedInAt: row.checked_in_at, blockNumber: row.block_number };
  const instructionsView = (row) => row && { instructions: row.instructions, updatedAt: row.updated_at };
  const windowOf = (onchain) => ({
    opensAt: Number(onchain.parkingStart) - ARRIVAL_OPENS_BEFORE,
    checkInOpensAt: Number(onchain.parkingStart) - CHECK_IN_OPENS_BEFORE,
    closesAt: Number(onchain.parkingEnd),
  });

  function readText(req, res) {
    const value = req.body?.instructions;
    if (typeof value === 'string' && value.trim().length <= MAX_INSTRUCTIONS) {
      // Hosted mode never stores them in the clear; local/demo mode does, and /api/settings says so.
      if (value.trim() && requireKey && !db.arrivalKey) {
        res.status(503).json({ error: 'Arrival instructions need BIDPARK_ARRIVAL_KEY to be set on this server' });
        return null;
      }
      return value.trim();
    }
    res.status(400).json({ error: `Instructions must be text of at most ${MAX_INSTRUCTIONS} characters` });
    return null;
  }

  /**
   * GET /api/auctions/:id/arrival: for a host, the stored instructions and the check-in; for the winner
   * inside the window, the instructions that apply (the auction's, else the space's) and their check-in.
   */
  app.get('/api/auctions/:id/arrival', async (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const a = await readAuction(req, res, s.session.address);
    if (!a) return;
    const checkIn = checkInView(db.getCheckIn(s.contract, a.id));
    const window = windowOf(a.onchain);
    if (a.isHost) {
      return res.json({
        role: 'host', auctionId: a.id, spaceId: a.spaceId, window, checkIn,
        auction: instructionsView(db.getArrivalInstructions(s.contract, 'auction', a.id)),
        space: instructionsView(db.getArrivalInstructions(s.contract, 'space', a.spaceId)),
      });
    }
    const access = winnerAccess({ ...a, address: s.session.address });
    if (!access.ok) return res.status(403).json({ error: access.error, reason: access.reason, window });
    const row = db.getArrivalInstructions(s.contract, 'auction', a.id) ?? db.getArrivalInstructions(s.contract, 'space', a.spaceId);
    res.json({ role: 'winner', auctionId: a.id, window, checkIn, instructions: row?.instructions ?? null });
  });

  /** POST /api/auctions/:id/arrival { instructions }: a host sets this auction's instructions ('' clears them). */
  app.post('/api/auctions/:id/arrival', async (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const text = readText(req, res);
    if (text === null) return;
    const a = await readAuction(req, res, s.session.address);
    if (!a) return;
    if (!a.isHost) return res.status(403).json({ error: "Only this auction's host can set its arrival instructions" });
    db.saveArrivalInstructions(s.contract, 'auction', a.id, { instructions: text, updatedBy: s.session.address });
    res.json({ saved: Boolean(text) });
  });

  /** POST /api/spaces/:spaceId/arrival { instructions }: the space's owner or lister sets its default instructions. */
  app.post('/api/spaces/:spaceId/arrival', async (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const spaceId = ID.test(req.params.spaceId) ? req.params.spaceId : null;
    if (!spaceId) return res.status(400).json({ error: 'Valid space id is required' });
    const text = readText(req, res);
    if (text === null) return;
    let lister;
    try {
      const { call } = await pinnedReader();
      [lister] = await call('isSpaceLister', [spaceId, s.session.address]);
    } catch {
      return res.status(503).json({ error: 'Blockchain service unavailable' });
    }
    if (!lister) return res.status(403).json({ error: "Only the space's owner or an approved lister can set its arrival instructions" });
    db.saveArrivalInstructions(s.contract, 'space', spaceId, { instructions: text, updatedBy: s.session.address });
    res.json({ saved: Boolean(text) });
  });

  /**
   * POST /api/auctions/:id/check-in: the winner records that they arrived. Off-chain and idempotent: the
   * first check-in is kept and a repeat returns it. It is an attestation, not proof of access.
   */
  app.post('/api/auctions/:id/check-in', async (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const a = await readAuction(req, res, s.session.address);
    if (!a) return;
    const window = windowOf(a.onchain);
    const access = winnerAccess({ ...a, address: s.session.address, opensBefore: CHECK_IN_OPENS_BEFORE });
    if (!access.ok) return res.status(403).json({ error: access.error, reason: access.reason, window });
    const [row, created] = db.recordCheckIn(s.contract, a.id, { winner: s.session.address, blockNumber: a.block.number });
    res.status(created ? 201 : 200).json({ checkIn: checkInView(row), window });
  });
}
