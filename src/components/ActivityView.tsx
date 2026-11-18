import React from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  Clock,
  ExternalLink,
  Gavel,
  Loader2,
  ParkingCircle,
  ShieldCheck,
  Ticket,
  Warehouse,
  Zap,
} from 'lucide-react';
import type { Listing } from '../types';
import type { ReadState } from '../utils/readState';
import {
  formatEth,
  formatParkingWindow,
  getAuctionTimeRemaining,
  getListingStatus,
  shortenAddress,
} from '../utils/formatters';

interface ActivityViewProps {
  currentAddress: string | null;
  listings: Listing[];
  claimableRefundWei: bigint | null;
  refundRead: ReadState;
  onRetryRefund: () => void;
  onWithdrawRefund: () => Promise<void>;
  onSettleListing: (listing: Listing) => Promise<void>;
  onCancelListing: (listing: Listing) => Promise<void>;
  onClaimPayoutListing: (listing: Listing) => Promise<void>;
  onOpenListingDetail: (listing: Listing) => void;
  onOpenBid: (listing: Listing) => void;
  isActionBusy: boolean;
}

export const ActivityView: React.FC<ActivityViewProps> = ({
  currentAddress,
  listings,
  claimableRefundWei,
  refundRead,
  onRetryRefund,
  onWithdrawRefund,
  onSettleListing,
  onCancelListing,
  onClaimPayoutListing,
  onOpenListingDetail,
  onOpenBid,
  isActionBusy,
}) => {
  if (!currentAddress) {
    return (
      <div className="activity-unconnected">
        <div className="unconnected-card">
          <Warehouse size={40} className="unconnected-icon" />
          <h2 className="unconnected-title">Connect Wallet for Activity</h2>
          <p className="unconnected-text">
            Connect a local test wallet or browser wallet to view your active bids, claimable outbid refunds, and confirmed parking reservations.
          </p>
        </div>
      </div>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const addrLower = currentAddress.toLowerCase();

  // 1. Confirmed reservations: strictly require settled === true
  const confirmedReservations = listings.filter(
    (l) =>
      l.highestBidder &&
      l.highestBidder.toLowerCase() === addrLower &&
      !l.cancelled &&
      l.settled
  );

  // 2. Won auctions awaiting settlement (bidding closed, winning bidder, but not yet settled)
  const pendingSettlementWins = listings.filter(
    (l) =>
      l.highestBidder &&
      l.highestBidder.toLowerCase() === addrLower &&
      !l.cancelled &&
      !l.settled &&
      l.bidEnd <= now
  );
  // 2. Active leading bids (Auction still open, you are highest bidder)
  const activeBids = listings.filter(
    (l) =>
      l.highestBidder &&
      l.highestBidder.toLowerCase() === addrLower &&
      !l.settled &&
      !l.cancelled &&
      l.bidEnd > now
  );

  // 3. Settleable auctions (Bidding ended, not settled yet, anyone can settle)
  const settleableAuctions = listings.filter(
    (l) => l.bidEnd <= now && !l.settled && !l.cancelled
  );

  // 4. Hosted spots (You are the owner)
  const hostedSpots = listings.filter(
    (l) => l.owner && l.owner.toLowerCase() === addrLower
  );

  // Only a successful current read may offer a withdrawal; unknown is never shown as zero.
  const hasRefund = refundRead.status === 'success' && claimableRefundWei !== null && claimableRefundWei > 0n;
  const refundUnavailable = refundRead.status === 'failed' || refundRead.status === 'stale';

  return (
    <div className="activity-container">
      {/* Activity Page Header */}
      <div className="activity-header">
        <div className="activity-header-left">
          <h1 className="activity-title">Driver & Host Activity</h1>
          <p className="activity-sub">
            Connected account: <code className="activity-addr">{shortenAddress(currentAddress, 8)}</code>
          </p>
        </div>
      </div>

      {/* 1. Claimable Outbid Refunds Section */}
      <section className="activity-section">
        <div className="activity-section-header">
          <div className="section-title-wrap">
            <ArrowDownLeft size={20} className="text-orange" />
            <h2 className="activity-section-title">Claimable Outbid Refunds</h2>
          </div>
          {hasRefund && (
            <span className="badge-ready-pill">Funds Ready</span>
          )}
        </div>

        {refundRead.status === 'loading' ? (
          <div className="activity-empty-box" aria-busy="true">
            <Loader2 size={22} className="is-spinning" />
            <div>
              <p className="activity-empty-heading">Checking for refunds…</p>
            </div>
          </div>
        ) : refundUnavailable ? (
          <div className="activity-empty-box refund-unavailable-box" role="alert">
            <AlertTriangle size={22} />
            <div>
              <p className="activity-empty-heading">Refund balance unavailable</p>
              <p className="activity-empty-text">
                {refundRead.error}.
                {claimableRefundWei !== null && ` Last known amount (stale): ${formatEth(claimableRefundWei)} ETH.`}
                {' '}Withdrawal is disabled until the balance can be read again.
              </p>
              <button type="button" className="read-status-retry" onClick={onRetryRefund}>
                Retry refund balance
              </button>
            </div>
          </div>
        ) : hasRefund ? (
          <div className="refund-card refund-card-active">
            <div className="refund-card-body">
              <div className="refund-amount-col">
                <span className="refund-label">Available to Withdraw:</span>
                <div className="refund-eth-row">
                  <span className="refund-eth-val">
                    {formatEth(claimableRefundWei)}
                  </span>
                  <span className="refund-eth-currency">ETH</span>
                </div>
              </div>
              <div className="refund-desc-col">
                <p className="refund-explainer">
                  You were outbid on an auction. The smart contract automatically credited your full bid amount to your pending returns. Click below to withdraw directly back to your wallet.
                </p>
              </div>
              <div className="refund-btn-col">
                <button
                  type="button"
                  className="btn-withdraw-refund"
                  onClick={onWithdrawRefund}
                  disabled={isActionBusy}
                >
                  {isActionBusy ? (
                    <>
                      <Loader2 size={16} className="is-spinning" />
                      <span>Withdrawing…</span>
                    </>
                  ) : (
                    <>
                      <ArrowDownLeft size={16} />
                      <span>Withdraw {formatEth(claimableRefundWei)} ETH</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="activity-empty-box">
            <ShieldCheck size={22} className="empty-check-icon" />
            <div>
              <p className="activity-empty-heading">No pending refunds</p>
              <p className="activity-empty-text">
                When you place a bid and another driver outbids you, 100% of your ETH is immediately credited here for withdrawal.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 2. Won Auctions Awaiting Settlement */}
      {pendingSettlementWins.length > 0 && (
        <section className="activity-section">
          <div className="activity-section-header">
            <div className="section-title-wrap">
              <Zap size={20} className="text-orange" />
              <h2 className="activity-section-title">
                Won Auctions — Settle to Confirm Reservation ({pendingSettlementWins.length})
              </h2>
            </div>
            <span className="badge-permissionless">Action Required</span>
          </div>

          <p className="settle-intro-text">
            Bidding has concluded with your winning bid! Execute on-chain settlement to finalize the smart contract escrow and generate your official reservation pass.
          </p>

          <div className="settle-cards-grid">
            {pendingSettlementWins.map((listing) => {
              const windowInfo = formatParkingWindow(
                listing.parkingStart,
                listing.parkingEnd
              );
              return (
                <div key={listing.id} className="settle-card">
                  <div className="settle-card-header">
                    <span className="settle-card-id">Auction #{listing.id}</span>
                    <span className="badge-ended">Cutoff Reached</span>
                  </div>
                  <h4 className="settle-card-title">{listing.title}</h4>
                  <p className="settle-card-sub">{listing.address}</p>

                  <div className="settle-card-meta">
                    <div>
                      <span className="meta-sub">Winning Bid:</span>
                      <p className="meta-val">{formatEth(listing.highestBid)} ETH</p>
                    </div>
                    <div>
                      <span className="meta-sub">Window:</span>
                      <p className="meta-val">{windowInfo.dateStr}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-trigger-settle"
                    onClick={() => onSettleListing(listing)}
                    disabled={isActionBusy}
                  >
                    <Zap size={15} />
                    <span>Settle Auction & Claim Pass</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Confirmed Reservations (Settled Onchain) */}
      <section className="activity-section">
        <div className="activity-section-header">
          <div className="section-title-wrap">
            <Ticket size={20} className="text-forest-green" />
            <h2 className="activity-section-title">
              Confirmed Reservations ({confirmedReservations.length})
            </h2>
          </div>
        </div>

        {confirmedReservations.length > 0 ? (
          <div className="reservations-grid">
            {confirmedReservations.map((listing) => {
              const windowInfo = formatParkingWindow(
                listing.parkingStart,
                listing.parkingEnd
              );
              const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                listing.address
              )}`;

              return (
                <div key={listing.id} className="reservation-pass-card">
                  <div className="pass-header">
                    <div className="pass-brand">
                      <ParkingCircle size={20} />
                      <span className="pass-brand-text">BidPark Escrow Pass</span>
                    </div>
                    <span className="pass-id">AUCTION #{listing.id}</span>
                  </div>

                  <div className="pass-body">
                    <div className="pass-spot-info">
                      <span className={`badge-kind badge-kind-${listing.kind}`}>
                        {listing.kind}
                      </span>
                      <h3 className="pass-spot-title">{listing.title}</h3>
                      <p className="pass-spot-address">{listing.address}</p>
                    </div>

                    <div className="pass-window-box">
                      <div className="pass-window-col">
                        <span className="pass-sublabel">Reserved Date:</span>
                        <span className="pass-val">{windowInfo.dateStr}</span>
                      </div>
                      <div className="pass-window-col">
                        <span className="pass-sublabel">Arrival & Departure:</span>
                        <span className="pass-val">{windowInfo.timeRange}</span>
                      </div>
                      <div className="pass-window-col">
                        <span className="pass-sublabel">Winning Bid:</span>
                        <span className="pass-val">{formatEth(listing.highestBid)} ETH</span>
                      </div>
                    </div>

                    <div className="pass-instructions-box">
                      <div className="pass-inst-header">
                        <ShieldCheck size={14} />
                        <span>Driver Verification Instructions:</span>
                      </div>
                      <p className="pass-inst-text">
                        Your reservation is verified on-chain on Hardhat smart contract. If requested by host or attendant, show your connected wallet address: <code>{shortenAddress(currentAddress, 6)}</code>.
                      </p>
                    </div>

                    <div className="pass-actions-row">
                      <a
                        href={googleMapsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-pass-nav"
                      >
                        <ExternalLink size={14} />
                        <span>Navigate in Maps</span>
                      </a>
                      <button
                        type="button"
                        className="btn-pass-details"
                        onClick={() => onOpenListingDetail(listing)}
                      >
                        View Full Details
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="activity-empty-box">
            <Ticket size={22} className="text-muted" />
            <div>
              <p className="activity-empty-heading">No reserved parking passes yet</p>
              <p className="activity-empty-text">
                Browse available Austin spots in Discover, place your bid, and when the auction ends, your pass will appear here.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 3. Active Bids (Leading Bids) */}
      <section className="activity-section">
        <div className="activity-section-header">
          <div className="section-title-wrap">
            <Gavel size={20} className="text-forest-green" />
            <h2 className="activity-section-title">
              Active Leading Bids ({activeBids.length})
            </h2>
          </div>
        </div>

        {activeBids.length > 0 ? (
          <div className="active-bids-table-wrap">
            <table className="activity-table">
              <thead>
                <tr>
                  <th>Auction</th>
                  <th>Parking Window</th>
                  <th>Your Lead Bid</th>
                  <th>Bidding Cutoff</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {activeBids.map((listing) => {
                  const windowInfo = formatParkingWindow(
                    listing.parkingStart,
                    listing.parkingEnd
                  );
                  const time = getAuctionTimeRemaining(listing.bidEnd);
                  return (
                    <tr key={listing.id}>
                      <td>
                        <div className="table-spot-cell">
                          <span className="table-spot-title">{listing.title}</span>
                          <span className="table-spot-sub">{listing.neighborhood}</span>
                        </div>
                      </td>
                      <td>
                        <span className="table-window-text">
                          {windowInfo.dateStr} • {windowInfo.timeRange}
                        </span>
                      </td>
                      <td>
                        <span className="table-bid-lead">
                          {formatEth(listing.highestBid)} ETH
                        </span>
                      </td>
                      <td>
                        <span className="table-countdown-text">
                          <Clock size={12} />
                          <span>{time.text}</span>
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-table-action"
                          onClick={() => onOpenListingDetail(listing)}
                        >
                          View Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="activity-empty-box">
            <Gavel size={22} className="text-muted" />
            <div>
              <p className="activity-empty-heading">No active leading bids</p>
              <p className="activity-empty-text">
                You are not currently the highest bidder on any open auctions.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 4. Settleable Auctions */}
      {settleableAuctions.length > 0 && (
        <section className="activity-section">
          <div className="activity-section-header">
            <div className="section-title-wrap">
              <Zap size={20} className="text-orange" />
              <h2 className="activity-section-title">
                Auctions Ready to Settle ({settleableAuctions.length})
              </h2>
            </div>
            <span className="badge-permissionless">Permissionless Settle</span>
          </div>

          <p className="settle-intro-text">
            Bidding has concluded for the following auctions. Any user can trigger settlement on-chain to finalize the winning reservation in smart contract escrow.
          </p>

          <div className="settle-cards-grid">
            {settleableAuctions.map((listing) => {
              const hasWinner = Boolean(listing.highestBidder) && parseFloat(listing.highestBid) > 0;
              return (
                <div key={listing.id} className="settle-card">
                  <div className="settle-card-header">
                    <span className="settle-card-id">Auction #{listing.id}</span>
                    <span className="badge-ended">Cutoff Reached</span>
                  </div>
                  <h4 className="settle-card-title">{listing.title}</h4>
                  <p className="settle-card-sub">{listing.address}</p>

                  <div className="settle-card-meta">
                    <div>
                      <span className="meta-sub">Winning Bid:</span>
                      <p className="meta-val">
                        {hasWinner ? `${formatEth(listing.highestBid)} ETH` : 'No bids'}
                      </p>
                    </div>
                    <div>
                      <span className="meta-sub">Winner:</span>
                      <p className="meta-val mono-val">
                        {hasWinner ? shortenAddress(listing.highestBidder, 4) : 'None'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-trigger-settle"
                    onClick={() => onSettleListing(listing)}
                    disabled={isActionBusy}
                  >
                    <Zap size={15} />
                    <span>Execute Settle(#{listing.id})</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 5. My Listed Parking Spots (Host View) */}
      <section className="activity-section">
        <div className="activity-section-header">
          <div className="section-title-wrap">
            <Warehouse size={20} className="text-forest-green" />
            <h2 className="activity-section-title">
              My Listed Spaces ({hostedSpots.length})
            </h2>
          </div>
        </div>

        {hostedSpots.length > 0 ? (
          <div className="hosted-grid">
            {hostedSpots.map((listing) => {
              const hasBids = parseFloat(listing.highestBid) > 0;
              const canCancel = !hasBids && !listing.settled && !listing.cancelled;
              const canClaim =
                listing.settled && hasBids && !listing.payoutClaimed && now >= listing.parkingEnd;
              const status = getListingStatus(listing);

              return (
                <div key={listing.id} className="hosted-spot-card">
                  <div className="hosted-card-header">
                    <span className={`badge-kind badge-kind-${listing.kind}`}>
                      {listing.kind}
                    </span>
                    <span className={`badge-status ${status.colorClass}`}>
                      {status.label}
                    </span>
                  </div>

                  <h3 className="hosted-title">{listing.title}</h3>
                  <p className="hosted-address">{listing.address}</p>

                  <div className="hosted-stats-box">
                    <div className="stat-col">
                      <span className="stat-label">Min Bid</span>
                      <span className="stat-val">{formatEth(listing.minBid)} ETH</span>
                    </div>
                    <div className="stat-col">
                      <span className="stat-label">Highest Bid</span>
                      <span className="stat-val">
                        {hasBids ? `${formatEth(listing.highestBid)} ETH` : 'No bids'}
                      </span>
                    </div>
                    <div className="stat-col">
                      <span className="stat-label">Status</span>
                      <span className="stat-val">{status.label}</span>
                    </div>
                  </div>

                  <div className="hosted-actions-row">
                    <button
                      type="button"
                      className="btn-hosted-view"
                      onClick={() => onOpenListingDetail(listing)}
                    >
                      View
                    </button>

                    {canCancel && (
                      <button
                        type="button"
                        className="btn-hosted-cancel"
                        onClick={() => onCancelListing(listing)}
                        disabled={isActionBusy}
                        title="Cancel listing (available only when no bids placed)"
                      >
                        Cancel
                      </button>
                    )}

                    {canClaim && (
                      <button
                        type="button"
                        className="btn-hosted-claim"
                        onClick={() => onClaimPayoutListing(listing)}
                        disabled={isActionBusy}
                        title="Claim host payout after parking window conclusion"
                      >
                        Claim Payout
                      </button>
                    )}

                    {listing.payoutClaimed && (
                      <span className="payout-claimed-tag">
                        Payout Claimed
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="activity-empty-box">
            <Warehouse size={22} className="text-muted" />
            <div>
              <p className="activity-empty-heading">No hosted spaces listed under this account</p>
              <p className="activity-empty-text">
                Have a private driveway or garage in Austin? Click "+ List a Spot" in the top bar to create an on-chain escrow auction.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
