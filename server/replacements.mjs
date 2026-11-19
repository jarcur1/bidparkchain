import { ethers } from 'ethers';
import { readSession } from './auth.mjs';

const ID = /^[1-9]\d{0,77}$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Links an auction that already had bids to the new auction its host published to replace it. Published
 * metadata is immutable, so a material change is a new auction; this only records the link so the original's
 * bidders can be pointed to it. Both auctions are checked on-chain: the caller must be the host of each
 * (auction owner, or its space's owner or approved lister), the original must have a bid, and the
 * replacement must be a later auction. Nothing here moves funds or cancels anything.
 */
export function mountReplacements(app, { db, pinnedReader, contractAddress }) {
  /** POST /api/auctions/:id/replacement { replacementId } */
  app.post('/api/auctions/:id/replacement', async (req, res) => {
    const session = readSession(db, req);
    if (!session) return res.status(401).json({ error: 'Sign in with your wallet first' });
    const contract = contractAddress();
    if (!contract) return res.status(503).json({ error: 'Smart contract not deployed' });
    const originalId = req.params.id;
    const replacementId = req.body?.replacementId;
    if (!ID.test(originalId) || typeof replacementId !== 'string' || !ID.test(replacementId) || BigInt(replacementId) <= BigInt(originalId)) {
      return res.status(400).json({ error: 'A replacement must be a later auction than the original' });
    }
    try {
      const { call } = await pinnedReader();
      const hostOf = async (id) => {
        const onchain = await call('auctions', [id]);
        if (onchain.owner === ethers.ZeroAddress) return { onchain, host: false };
        const [spaceId] = await call('auctionSpace', [id]);
        return { onchain, host: same(onchain.owner, session.address) || (await call('isSpaceLister', [spaceId, session.address]))[0] };
      };
      const [original, replacement] = await Promise.all([hostOf(originalId), hostOf(replacementId)]);
      if (original.onchain.owner === ethers.ZeroAddress || replacement.onchain.owner === ethers.ZeroAddress) {
        return res.status(404).json({ error: 'Auction does not exist' });
      }
      if (!original.host || !replacement.host) return res.status(403).json({ error: 'Only the host of both auctions can link a replacement' });
      if (original.onchain.highestBidder === ethers.ZeroAddress) {
        return res.status(409).json({ error: 'The original auction has no bids, so it can be cancelled instead' });
      }
      if (!db.saveReplacement(contract, originalId, replacementId, session.address)) {
        return res.status(409).json({ error: 'This auction already has a replacement recorded' });
      }
      res.status(201).json({ linked: true });
    } catch {
      res.status(503).json({ error: 'Blockchain service unavailable' });
    }
  });

  /** GET /api/auctions/:id/replacement: the replacement auction id, if the host recorded one (public). */
  app.get('/api/auctions/:id/replacement', (req, res) => {
    const contract = contractAddress();
    if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Valid auction id is required' });
    const row = contract && db.getReplacements(contract, [req.params.id])[0];
    res.json({ replacementId: row?.replacement_id ?? null });
  });
}
