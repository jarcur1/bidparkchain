import React, { useCallback, useEffect, useState } from 'react';
import type { Listing } from '../types';
import { checkInArrival, getArrival, saveArrival, type ArrivalView } from '../services/workspace';
import { ARRIVAL_OPENS_BEFORE, CHECK_IN_OPENS_BEFORE } from '../utils/booking';
import { formatDateTime, shortenAddress } from '../utils/formatters';

const ATTESTATION =
  "A check-in is the winner's own statement that they arrived, recorded by BidPark off-chain. It is not proof of access, and the contract does not read it.";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Private arrival instructions and check-in for one auction. The host edits them and sees the check-in;
 * the settled winner reads them and checks in. The API decides who may see what, and when.
 */
export const ArrivalPanel: React.FC<{ listing: Listing; currentAddress: string | null; signedIn: boolean }> = ({
  listing, currentAddress, signedIn,
}) => {
  const me = currentAddress?.toLowerCase() ?? '';
  const isHost = Boolean(me) && listing.owner.toLowerCase() === me;
  const isWinner = Boolean(me) && listing.settled && !listing.cancelled && listing.highestBidder.toLowerCase() === me;
  const [view, setView] = useState<ArrivalView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [auctionText, setAuctionText] = useState('');
  const [spaceText, setSpaceText] = useState('');

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const next = await getArrival(listing.id);
      setView(next);
      if (next.role === 'host') {
        setAuctionText(next.auction?.instructions ?? '');
        setSpaceText(next.space?.instructions ?? '');
      }
    } catch (err) {
      setStatus(message(err));
    }
  }, [listing.id]);
  useEffect(() => {
    setView(null);
    setStatus(null);
    if (isHost && signedIn) void load();
  }, [load, isHost, signedIn]);

  if (!isHost && !isWinner) return null;
  const zone = listing.timeZone;
  const opens = formatDateTime(listing.parkingStart - ARRIVAL_OPENS_BEFORE, zone);
  const closes = formatDateTime(listing.parkingEnd, zone);

  async function save(scope: 'auctions' | 'spaces', id: string, text: string) {
    try {
      setStatus((await saveArrival(scope, id, text)).saved ? 'Arrival instructions saved.' : 'Arrival instructions removed.');
    } catch (err) {
      setStatus(message(err));
    }
  }
  async function checkIn() {
    try {
      const record = await checkInArrival(listing.id);
      setView((v) => (v ? { ...v, checkIn: record } : v));
      setStatus(null);
    } catch (err) {
      setStatus(message(err));
    }
  }

  return (
    <section className="arrival-panel" data-testid="arrival-panel" aria-label="Arrival">
      <h3 className="arrival-title">Arrival</h3>
      {!signedIn ? (
        <p className="auction-disclosure-subtext">Sign in with your wallet to {isHost ? 'manage' : 'see'} private arrival instructions.</p>
      ) : isHost && view?.role !== 'host' ? (
        <p className="auction-disclosure-subtext">Loading arrival instructions…</p>
      ) : isHost ? (
        <>
          <p className="auction-disclosure-subtext">
            Only the settled winner can read these, from {opens} until {closes}. Keep gate codes here, never in the public description.
          </p>
          <div className="verification-form">
            <textarea aria-label="Arrival instructions for this auction" maxLength={2000} rows={3} value={auctionText}
              placeholder="Instructions for this auction (leave empty to use the space default)" onChange={(e) => setAuctionText(e.target.value)} />
            <button type="button" className="btn-table-action" onClick={() => void save('auctions', listing.id, auctionText)}>Save for this auction</button>
          </div>
          <div className="verification-form">
            <textarea aria-label={`Default arrival instructions for space ${listing.spaceId}`} maxLength={2000} rows={2} value={spaceText}
              placeholder={`Default for every auction of space #${listing.spaceId}`} onChange={(e) => setSpaceText(e.target.value)} />
            <button type="button" className="btn-table-action" onClick={() => void save('spaces', listing.spaceId, spaceText)}>Save space default</button>
          </div>
          <p role="status" data-testid="arrival-checkin">
            {view?.checkIn
              ? `Winner ${shortenAddress(view.checkIn.winner)} checked in at ${formatDateTime(Math.floor(view.checkIn.checkedInAt / 1000), zone)}.`
              : 'No check-in recorded.'}
          </p>
          <p className="auction-disclosure-subtext">
            {ATTESTATION} Recording a no-show on a protected booking stays a separate on-chain action, and it moves no funds.
          </p>
        </>
      ) : (
        <>
          <p className="auction-disclosure-subtext">
            Private to you: visible from {opens} until {closes}. Check-in opens at {formatDateTime(listing.parkingStart - CHECK_IN_OPENS_BEFORE, zone)}.
          </p>
          {view?.role === 'winner' ? (
            <>
              <p className="arrival-instructions" data-testid="arrival-instructions">
                {view.instructions ?? 'The host has not added arrival instructions.'}
              </p>
              {view.checkIn ? (
                <p role="status" data-testid="arrival-checkin">Checked in at {formatDateTime(Math.floor(view.checkIn.checkedInAt / 1000), zone)}.</p>
              ) : (
                <button type="button" className="btn-modal-settle" onClick={() => void checkIn()}>Check in</button>
              )}
            </>
          ) : (
            <button type="button" className="btn-table-action" onClick={() => void load()}>Show arrival instructions</button>
          )}
          <p className="auction-disclosure-subtext">
            {ATTESTATION} If the instructions do not work or the space is unavailable on a protected booking, use Report seller failure.
          </p>
        </>
      )}
      {status && <p role="status" data-testid="arrival-status">{status}</p>}
    </section>
  );
};
