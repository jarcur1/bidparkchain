// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ParkingAuctionEscrow
 * @notice Real local Solidity escrow for timed private parking spot auctions.
 * All value sends are protected by checks-effects-interactions and reentrancy guards.
 */
contract ParkingAuctionEscrow {
    struct Auction {
        address owner;
        address highestBidder;
        bytes32 metadataHash;
        uint256 minBid;
        uint256 highestBid;
        uint64 bidEnd;
        uint64 parkingStart;
        uint64 parkingEnd;
        bool settled;
        bool cancelled;
        bool payoutClaimed;
    }

    uint256 public nextAuctionId = 1;
    mapping(uint256 => Auction) public auctions;
    mapping(address => uint256) public pendingReturns;

    // Parking-space inventory: every auction reserves a window on exactly one space.
    uint256 public nextSpaceId = 1;
    mapping(uint256 => address) public spaceOwner;
    mapping(uint256 => uint256) public auctionSpace;
    mapping(uint256 => uint256[]) private _spaceAuctions;

    // Delegated listers belong to one ownership of a space: a transfer bumps the epoch and drops them.
    mapping(uint256 => uint256) private _spaceEpoch;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) private _listers;
    /// IANA time zone name of the space's location (e.g. "America/Chicago"); empty until the owner sets it.
    mapping(uint256 => string) public spaceTimeZone;

    // A verifier attests one opaque canonical identity per physical stall. The binding survives
    // revocation and transfer: all windows for that identity must keep using the same calendar.
    bool public verifiedInventoryRequired;
    mapping(address => bool) public spaceVerifiers;
    mapping(uint256 => bytes32) public spaceIdentity;
    mapping(bytes32 => uint256) public spaceForIdentity;
    mapping(uint256 => bytes32) public spaceVerifiedMetadata;

    struct BlockedWindow {
        uint256 spaceId;
        uint64 start;
        uint64 end;
    }
    uint256 public nextBlockId = 1;
    mapping(uint256 => BlockedWindow) public blockedWindows;

    // Windows (auctions and blocks) that may still matter for overlap checks, one storage slot each.
    // Entries that can never overlap a new window again are pruned during each check, and at most
    // MAX_SPACE_WINDOWS live entries are kept, so the check's gas is bounded per space.
    struct LiveWindow {
        uint64 start;
        uint64 end;
        uint64 bidEnd;
        uint56 id;
        bool blocked;
    }
    uint256 public constant MAX_SPACE_WINDOWS = 64;
    mapping(uint256 => LiveWindow[]) private _liveWindows;

    uint256 private _status = 1;

    // Protected bookings (protocol version 2, docs/booking-policy.md). Auctions made with
    // createAuction/createSpaceAuction keep the version 1 rules; only createProtectedAuction opts in.
    uint64 public constant MIN_BID_LEAD = 30 minutes; // parkingStart - bidEnd
    uint64 public constant EARLY_CANCEL_NOTICE = 24 hours; // before parkingStart
    uint64 public constant NO_SHOW_GRACE = 30 minutes; // after parkingStart
    uint64 public constant REPORT_WINDOW = 24 hours; // after parkingEnd; also the host-claim hold
    uint64 public constant RESOLUTION_WINDOW = 72 hours; // after parkingEnd

    /// Terminal disposition of a protected winning principal. None while it is still held.
    enum Outcome { None, WinnerCancelled, HostCancelled, Expired, DisputeUpheld, DisputeExpired, HostPaid }

    struct Booking {
        bool isProtected;
        Outcome outcome;
        bool lateCancelled;
        bool noShowRecorded;
        address disputeReporter; // non-zero while a seller-failure report is open
        bytes32 disputeEvidence; // opaque reference into the off-chain review record
    }
    mapping(uint256 => Booking) public bookings;

    /// Deployer; may only add or remove resolvers. It holds no funds and cannot decide disputes itself.
    /// Plain storage, not immutable: deploy.mjs matches deployed code against the compiled runtime.
    address public resolverAdmin;
    mapping(address => bool) public resolvers;

    // Custom errors
    error InvalidMetadataHash();
    error InvalidMinBid();
    error InvalidTimeWindow();
    error AuctionNotFound();
    error AuctionCancelledError();
    error AlreadySettled();
    error AlreadyCancelled();
    error AuctionEnded();
    error AuctionNotEnded();
    error OwnerCannotBid();
    error BidTooLow();
    error NotAuctionOwner();
    error HasBidsCannotCancel();
    error NotSettled();
    error ParkingNotEnded();
    error PayoutAlreadyClaimed();
    error NoBidsToPayout();
    error ZeroRefund();
    error TransferFailed();
    error ReentrantCall();
    error NotSpaceOwner();
    error SpaceWindowTaken(uint256 auctionId);
    error SpaceWindowUnavailable(uint256 blockId);
    error SpaceCalendarFull();
    error InvalidSpaceOwner();
    error InvalidTimeZone();
    error BlockedWindowNotFound();
    error NotSpaceVerifier();
    error SpaceNotVerified();
    error StaleSpaceOwnership();
    error InvalidSpaceIdentity();
    error UnverifiedSpaceMetadata();
    error SpaceIdentityTaken(uint256 spaceId);
    error NotProtected();
    error NotWinner();
    error NotResolver();
    error ResolverIsParty();
    error TooEarly();
    error TooLate();
    error BookingFinalized();
    error AlreadyRecorded();
    error DisputeOpen();
    error NoOpenDispute();
    error InvalidEvidence();

    // Events
    event AuctionCreated(uint256 indexed id, address indexed owner);
    event BidPlaced(uint256 indexed id, address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed recipient, uint256 amount);
    event AuctionSettled(uint256 indexed id, address indexed winner, uint256 amount);
    event PayoutClaimed(uint256 indexed id, address indexed owner, uint256 amount);
    event AuctionCancelled(uint256 indexed id);
    event SpaceRegistered(uint256 indexed spaceId, address indexed owner);
    event SpaceTransferred(uint256 indexed spaceId, address indexed from, address indexed to);
    event SpaceListerSet(uint256 indexed spaceId, address indexed lister, bool allowed);
    event SpaceTimeZoneSet(uint256 indexed spaceId, string timeZone);
    event SpaceWindowBlocked(uint256 indexed spaceId, uint256 indexed blockId, uint64 start, uint64 end);
    event SpaceWindowUnblocked(uint256 indexed spaceId, uint256 indexed blockId);
    event SpaceVerifierSet(address indexed verifier, bool allowed);
    event SpaceVerificationSet(uint256 indexed spaceId, uint256 indexed epoch, bool verified);
    event ProtectedAuctionCreated(uint256 indexed id);
    event ResolverSet(address indexed resolver, bool allowed);
    /// The full winning principal was credited to the winner for withdrawal (terminal).
    event BookingRefunded(uint256 indexed id, address indexed winner, uint256 amount, Outcome outcome);
    event LateCancellationRecorded(uint256 indexed id, address indexed winner);
    event NoShowRecorded(uint256 indexed id, address indexed host);
    event DisputeOpened(uint256 indexed id, address indexed reporter, bytes32 evidence);
    event DisputeResolved(uint256 indexed id, address indexed resolver, bool upheld, bytes32 decision);

    modifier nonReentrant() {
        if (_status == 2) revert ReentrantCall();
        _status = 2;
        _;
        _status = 1;
    }

    constructor(bool requireVerifiedInventory) {
        resolverAdmin = msg.sender;
        verifiedInventoryRequired = requireVerifiedInventory;
    }

    modifier onlySpaceOwner(uint256 spaceId) {
        if (spaceOwner[spaceId] != msg.sender) revert NotSpaceOwner();
        _;
    }

    /** @notice The deployment admin manages this role independently of dispute resolvers. */
    function setSpaceVerifier(address verifier, bool allowed) external {
        if (msg.sender != resolverAdmin) revert NotSpaceVerifier();
        spaceVerifiers[verifier] = allowed;
        emit SpaceVerifierSet(verifier, allowed);
    }

    /** @notice Changes on every ownership transfer, including a transfer back to an earlier owner. */
    function spaceOwnershipEpoch(uint256 spaceId) external view returns (uint256) {
        return _spaceEpoch[spaceId];
    }

    /** @notice Inventory and verification snapshot for an auction, read at the same block as its bid state. */
    function auctionInventory(uint256 id) external view returns (
        uint256 spaceId, string memory timeZone, address owner, bool required, bool verified, bool canAcceptBids
    ) {
        spaceId = auctionSpace[id];
        timeZone = spaceTimeZone[spaceId];
        owner = spaceOwner[spaceId];
        required = verifiedInventoryRequired;
        bytes32 approvedMetadata = spaceVerifiedMetadata[spaceId];
        Auction storage auction = auctions[id];
        verified = approvedMetadata != bytes32(0) && approvedMetadata == auction.metadataHash;
        canAcceptBids = !required || (verified && isSpaceLister(spaceId, auction.owner));
    }

    /**
     * @notice Approves or suspends a space for the reviewed owner and ownership epoch. For approval,
     * pass the same opaque identity for aliases of the same stall and the reviewed listing hash.
     * Passing zero for both suspends approval without changing existing commitments.
     * A verifier cannot approve a space it owns or may list, and cannot move an identity to a new id.
     */
    function setSpaceVerification(uint256 spaceId, address owner, uint256 epoch, bytes32 identity, bytes32 metadataHash)
        external
    {
        if (!spaceVerifiers[msg.sender]) revert NotSpaceVerifier();
        if (owner == address(0) || spaceOwner[spaceId] != owner || _spaceEpoch[spaceId] != epoch) {
            revert StaleSpaceOwnership();
        }
        if ((identity == bytes32(0)) != (metadataHash == bytes32(0))) revert InvalidSpaceIdentity();
        if (identity != bytes32(0)) {
            if (isSpaceLister(spaceId, msg.sender)) revert NotSpaceVerifier();
            bytes32 current = spaceIdentity[spaceId];
            if (current != identity) {
                if (current != bytes32(0)) revert InvalidSpaceIdentity();
                uint256 existing = spaceForIdentity[identity];
                if (existing != 0) revert SpaceIdentityTaken(existing);
                spaceIdentity[spaceId] = identity;
                spaceForIdentity[identity] = spaceId;
            }
        }
        bool approved = identity != bytes32(0);
        spaceVerifiedMetadata[spaceId] = metadataHash;
        emit SpaceVerificationSet(spaceId, epoch, approved);
    }

    /**
     * @notice Registers a new parking space owned by msg.sender. Its id never changes.
     */
    function registerSpace() external returns (uint256 spaceId) {
        spaceId = _registerSpace();
    }

    /**
     * @notice Creates a one-off auction on a newly registered space owned by msg.sender.
     * @param metadataHash Canonical keccak256 hash of normalized listing metadata.
     * @param minBid Minimum required starting bid (in wei).
     * @param bidEnd Unix timestamp when bidding closes.
     * @param parkingStart Unix timestamp when the parking reservation starts.
     * @param parkingEnd Unix timestamp when the parking reservation ends.
     */
    function createAuction(
        bytes32 metadataHash,
        uint256 minBid,
        uint64 bidEnd,
        uint64 parkingStart,
        uint64 parkingEnd
    ) external returns (uint256 id) {
        if (verifiedInventoryRequired) revert SpaceNotVerified();
        id = _createAuction(_registerSpace(), metadataHash, minBid, bidEnd, parkingStart, parkingEnd);
    }

    /**
     * @notice Creates an auction for a window on an existing space. The space owner or a lister it
     * delegated may list it; the lister becomes the auction owner (cancels it, receives the payout).
     * The window [parkingStart, parkingEnd) must not overlap any window the space still holds or has
     * blocked. Adjacent windows (one ends exactly when the next starts) do not overlap.
     */
    function createSpaceAuction(
        uint256 spaceId,
        bytes32 metadataHash,
        uint256 minBid,
        uint64 bidEnd,
        uint64 parkingStart,
        uint64 parkingEnd
    ) external returns (uint256 id) {
        _checkListableSpace(spaceId, metadataHash, parkingStart, parkingEnd);
        id = _createAuction(spaceId, metadataHash, minBid, bidEnd, parkingStart, parkingEnd);
    }

    /**
     * @notice Creates a protected-booking auction (protocol version 2): winner cancellation, host
     * cancellation, settlement expiry, seller-failure disputes and a held host payout, as specified in
     * docs/booking-policy.md. spaceId 0 registers a new space; otherwise the createSpaceAuction rules
     * apply. Bidding must close at least MIN_BID_LEAD before parking starts.
     */
    function createProtectedAuction(
        uint256 spaceId,
        bytes32 metadataHash,
        uint256 minBid,
        uint64 bidEnd,
        uint64 parkingStart,
        uint64 parkingEnd
    ) external returns (uint256 id) {
        if (uint256(parkingStart) < uint256(bidEnd) + MIN_BID_LEAD) revert InvalidTimeWindow();
        if (spaceId == 0) {
            if (verifiedInventoryRequired) revert SpaceNotVerified();
            spaceId = _registerSpace();
        } else {
            _checkListableSpace(spaceId, metadataHash, parkingStart, parkingEnd);
        }
        id = _createAuction(spaceId, metadataHash, minBid, bidEnd, parkingStart, parkingEnd);
        bookings[id].isProtected = true;
        emit ProtectedAuctionCreated(id);
    }

    /** @notice Adds or removes a dispute resolver. Only the deployer may call it. */
    function setResolver(address resolver, bool allowed) external {
        if (msg.sender != resolverAdmin) revert NotResolver();
        resolvers[resolver] = allowed;
        emit ResolverSet(resolver, allowed);
    }

    /** @notice True if `account` may list windows on the space: its owner or a delegated lister. */
    function isSpaceLister(uint256 spaceId, address account) public view returns (bool) {
        address owner = spaceOwner[spaceId];
        return owner != address(0) && (account == owner || _listers[spaceId][_spaceEpoch[spaceId]][account]);
    }

    /**
     * @notice Grants or revokes a delegated lister. Revoking stops new listings only: the lister's
     * auctions with bids stand, and the space owner may cancel the bidless ones.
     */
    function setSpaceLister(uint256 spaceId, address lister, bool allowed) external onlySpaceOwner(spaceId) {
        _listers[spaceId][_spaceEpoch[spaceId]][lister] = allowed;
        emit SpaceListerSet(spaceId, lister, allowed);
    }

    /**
     * @notice Transfers the space to a new owner and drops every delegated lister. Existing auctions,
     * their bids and payouts are unchanged; the new owner may cancel the bidless ones.
     */
    function transferSpace(uint256 spaceId, address newOwner) external onlySpaceOwner(spaceId) {
        if (newOwner == address(0)) revert InvalidSpaceOwner();
        _spaceEpoch[spaceId]++;
        if (spaceVerifiedMetadata[spaceId] != bytes32(0)) {
            delete spaceVerifiedMetadata[spaceId];
            emit SpaceVerificationSet(spaceId, _spaceEpoch[spaceId], false);
        }
        spaceOwner[spaceId] = newOwner;
        emit SpaceTransferred(spaceId, msg.sender, newOwner);
    }

    /**
     * @notice Sets the IANA time zone name of the space's location ("" clears it). Only the name's
     * shape is checked here (up to 64 of A-Z a-z 0-9 _ + - /); clients resolve the name.
     */
    function setSpaceTimeZone(uint256 spaceId, string calldata timeZone) external onlySpaceOwner(spaceId) {
        bytes calldata name = bytes(timeZone);
        if (name.length > 64) revert InvalidTimeZone();
        for (uint256 i = 0; i < name.length; i++) {
            bytes1 c = name[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") ||
                c == "_" || c == "+" || c == "-" || c == "/";
            if (!ok) revert InvalidTimeZone();
        }
        spaceTimeZone[spaceId] = timeZone;
        emit SpaceTimeZoneSet(spaceId, timeZone);
    }

    /**
     * @notice Blocks [start, end) on the space so nothing can be listed there. It must not overlap a
     * window the space still holds or has blocked; it never affects existing auctions.
     */
    function blockSpaceWindow(uint256 spaceId, uint64 start, uint64 end)
        external
        onlySpaceOwner(spaceId)
        returns (uint256 blockId)
    {
        if (end <= start || end <= block.timestamp) revert InvalidTimeWindow();
        _checkWindowFree(spaceId, start, end);
        blockId = nextBlockId++;
        blockedWindows[blockId] = BlockedWindow({spaceId: spaceId, start: start, end: end});
        _liveWindows[spaceId].push(LiveWindow(start, end, 0, uint56(blockId), true));
        emit SpaceWindowBlocked(spaceId, blockId, start, end);
    }

    /** @notice Removes a blocked window, making that time listable again. */
    function unblockSpaceWindow(uint256 blockId) external {
        uint256 spaceId = blockedWindows[blockId].spaceId;
        if (spaceId == 0) revert BlockedWindowNotFound();
        if (spaceOwner[spaceId] != msg.sender) revert NotSpaceOwner();
        delete blockedWindows[blockId];
        LiveWindow[] storage live = _liveWindows[spaceId];
        for (uint256 i = 0; i < live.length; i++) {
            if (live[i].blocked && live[i].id == blockId) {
                live[i] = live[live.length - 1];
                live.pop();
                break;
            }
        }
        emit SpaceWindowUnblocked(spaceId, blockId);
    }

    /** @notice Blocked windows on the space not yet removed or pruned (some may already have ended). */
    function spaceBlockedWindows(uint256 spaceId) external view returns (uint256[] memory ids) {
        LiveWindow[] storage live = _liveWindows[spaceId];
        uint256 count;
        for (uint256 i = 0; i < live.length; i++) if (live[i].blocked) count++;
        ids = new uint256[](count);
        for (uint256 i = live.length; i > 0; ) if (live[--i].blocked) ids[--count] = live[i].id;
    }

    /**
     * @dev Reverts if [start, end) overlaps a held or blocked window. Prunes entries that can never
     * overlap a new window again: windows that ended at or before this block (every new window ends
     * after it) and released auctions (once holdsWindow is false it stays false). The auction itself
     * is only read when its bidding has closed or it overlaps, so most entries cost one slot read.
     */
    function _checkWindowFree(uint256 spaceId, uint64 start, uint64 end) private {
        LiveWindow[] storage live = _liveWindows[spaceId];
        for (uint256 i = live.length; i > 0; ) {
            LiveWindow memory w = live[--i];
            bool overlaps = start < w.end && w.start < end;
            bool released = w.end <= block.timestamp ||
                (!w.blocked && (overlaps || block.timestamp >= w.bidEnd) && !holdsWindow(w.id));
            if (released) {
                if (i != live.length - 1) live[i] = live[live.length - 1];
                live.pop();
            } else if (overlaps) {
                if (w.blocked) revert SpaceWindowUnavailable(w.id);
                revert SpaceWindowTaken(w.id);
            }
        }
        if (live.length >= MAX_SPACE_WINDOWS) revert SpaceCalendarFull();
    }

    /**
     * @notice True while an auction still reserves its window on its space: it is not cancelled and it
     * either has a bid (a winning reservation once settled) or bidding is still open. A cancelled auction,
     * or one whose bidding closed with no bids, releases its window.
     */
    function holdsWindow(uint256 id) public view returns (bool) {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0) || auction.cancelled) return false;
        return auction.highestBidder != address(0) || block.timestamp < auction.bidEnd;
    }

    /**
     * @notice Every auction ever created on a space, oldest first: the space's calendar.
     */
    function spaceAuctions(uint256 spaceId) external view returns (uint256[] memory) {
        return _spaceAuctions[spaceId];
    }

    function _registerSpace() private returns (uint256 spaceId) {
        spaceId = nextSpaceId++;
        spaceOwner[spaceId] = msg.sender;
        emit SpaceRegistered(spaceId, msg.sender);
    }

    function _checkListableSpace(uint256 spaceId, bytes32 metadataHash, uint64 start, uint64 end) private {
        if (!isSpaceLister(spaceId, msg.sender)) revert NotSpaceOwner();
        if (verifiedInventoryRequired) _checkApprovedMetadata(spaceId, metadataHash);
        _checkWindowFree(spaceId, start, end);
    }

    function _checkApprovedMetadata(uint256 spaceId, bytes32 metadataHash) private view {
        bytes32 approved = spaceVerifiedMetadata[spaceId];
        if (approved == bytes32(0)) revert SpaceNotVerified();
        if (metadataHash != approved) revert UnverifiedSpaceMetadata();
    }

    function _createAuction(
        uint256 spaceId,
        bytes32 metadataHash,
        uint256 minBid,
        uint64 bidEnd,
        uint64 parkingStart,
        uint64 parkingEnd
    ) private returns (uint256 id) {
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (minBid == 0) revert InvalidMinBid();
        if (bidEnd <= block.timestamp || parkingStart < bidEnd || parkingEnd <= parkingStart) {
            revert InvalidTimeWindow();
        }

        id = nextAuctionId++;
        auctions[id] = Auction({
            owner: msg.sender,
            highestBidder: address(0),
            metadataHash: metadataHash,
            minBid: minBid,
            highestBid: 0,
            bidEnd: bidEnd,
            parkingStart: parkingStart,
            parkingEnd: parkingEnd,
            settled: false,
            cancelled: false,
            payoutClaimed: false
        });
        auctionSpace[id] = spaceId;
        _spaceAuctions[spaceId].push(id);
        _liveWindows[spaceId].push(LiveWindow(parkingStart, parkingEnd, bidEnd, uint56(id), false));

        emit AuctionCreated(id, msg.sender);
    }

    /**
     * @notice Places a new bid on an active auction.
     * Full new bid is sent in msg.value.
     * Prior highest bid is credited to pendingReturns.
     */
    function bid(uint256 id) external payable nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (auction.cancelled) revert AlreadyCancelled();
        if (auction.settled) revert AlreadySettled();
        if (block.timestamp >= auction.bidEnd) revert AuctionEnded();
        if (msg.sender == auction.owner) revert OwnerCannotBid();
        if (verifiedInventoryRequired) {
            uint256 spaceId = auctionSpace[id];
            _checkApprovedMetadata(spaceId, auction.metadataHash);
            if (!isSpaceLister(spaceId, auction.owner)) revert NotSpaceOwner();
        }
        if (msg.value < auction.minBid || msg.value <= auction.highestBid) revert BidTooLow();

        address previousBidder = auction.highestBidder;
        uint256 previousBid = auction.highestBid;

        auction.highestBidder = msg.sender;
        auction.highestBid = msg.value;

        if (previousBidder != address(0)) {
            pendingReturns[previousBidder] += previousBid;
        }

        emit BidPlaced(id, msg.sender, msg.value);
    }

    /**
     * @notice Withdraws all pending returns for msg.sender.
     */
    function withdrawRefund() external nonReentrant {
        uint256 refund = pendingReturns[msg.sender];
        if (refund == 0) revert ZeroRefund();

        pendingReturns[msg.sender] = 0;

        (bool success, ) = msg.sender.call{value: refund}("");
        if (!success) revert TransferFailed();

        emit RefundWithdrawn(msg.sender, refund);
    }

    /**
     * @notice Settles an ended auction. Permissionless.
     * Winner reservation is recorded onchain by highestBidder + settled = true.
     */
    function settle(uint256 id) external nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (auction.cancelled) revert AlreadyCancelled();
        if (auction.settled) revert AlreadySettled();
        if (block.timestamp < auction.bidEnd) revert AuctionNotEnded();
        // Protected: a winner can only be settled before parking starts; after that, expire() refunds it.
        if (bookings[id].isProtected && auction.highestBidder != address(0) && block.timestamp >= auction.parkingStart) {
            revert TooLate();
        }

        auction.settled = true;

        emit AuctionSettled(id, auction.highestBidder, auction.highestBid);
    }

    /**
     * @notice Host claims the winning bid. Version 1: paid directly at or after parkingEnd.
     * Protected: only at or after parkingEnd + REPORT_WINDOW with no open dispute, and credited to
     * pendingReturns for withdrawRefund rather than sent.
     */
    function claimPayout(uint256 id) external nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (msg.sender != auction.owner) revert NotAuctionOwner();
        if (!auction.settled) revert NotSettled();
        if (block.timestamp < auction.parkingEnd) revert ParkingNotEnded();
        if (auction.payoutClaimed) revert PayoutAlreadyClaimed();
        if (auction.highestBidder == address(0) || auction.highestBid == 0) revert NoBidsToPayout();
        if (auction.cancelled) revert BookingFinalized();

        auction.payoutClaimed = true;
        uint256 payout = auction.highestBid;

        Booking storage booking = bookings[id];
        if (booking.isProtected) {
            if (block.timestamp < uint256(auction.parkingEnd) + REPORT_WINDOW) revert TooEarly();
            if (booking.disputeReporter != address(0)) revert DisputeOpen();
            booking.outcome = Outcome.HostPaid;
            pendingReturns[auction.owner] += payout;
            emit PayoutClaimed(id, auction.owner, payout);
            return;
        }

        (bool success, ) = auction.owner.call{value: payout}("");
        if (!success) revert TransferFailed();

        emit PayoutClaimed(id, auction.owner, payout);
    }

    /**
     * @notice Cancels an auction before any bids have been received. The auction owner or the
     * current owner of its space (e.g. after revoking the lister who created it) may cancel.
     */
    function cancel(uint256 id) external nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (msg.sender != auction.owner && msg.sender != spaceOwner[auctionSpace[id]]) revert NotAuctionOwner();
        if (auction.settled) revert AlreadySettled();
        if (auction.cancelled) revert AlreadyCancelled();
        if (auction.highestBidder != address(0) || auction.highestBid > 0) revert HasBidsCannotCancel();

        auction.cancelled = true;

        emit AuctionCancelled(id);
    }

    // ---------------------------------------------------------------------------------------------
    // Protected bookings. None of these send ETH: every refund or payout is a pendingReturns credit.

    /**
     * @notice Expires a protected auction whose winner was not settled before parkingStart: the
     * winner is credited the full principal. Permissionless.
     */
    function expire(uint256 id) external nonReentrant {
        Auction storage auction = _openBooking(id);
        if (auction.settled) revert AlreadySettled();
        if (auction.highestBidder == address(0)) revert NoBidsToPayout();
        if (block.timestamp < auction.parkingStart) revert TooEarly();
        _refundWinner(id, Outcome.Expired);
    }

    /**
     * @notice Winner cancels a settled protected booking before parkingStart. At least
     * EARLY_CANCEL_NOTICE ahead it is refunded in full; later it is only recorded (no refund: the
     * host may still claim after the hold unless a seller-failure report is upheld or expires).
     */
    function cancelBooking(uint256 id) external nonReentrant {
        Auction storage auction = _openBooking(id);
        if (msg.sender != auction.highestBidder) revert NotWinner();
        if (!auction.settled) revert NotSettled();
        if (block.timestamp >= auction.parkingStart) revert TooLate();
        if (block.timestamp + EARLY_CANCEL_NOTICE <= auction.parkingStart) {
            _refundWinner(id, Outcome.WinnerCancelled);
        } else {
            Booking storage booking = bookings[id];
            if (booking.lateCancelled) revert AlreadyRecorded();
            booking.lateCancelled = true;
            emit LateCancellationRecorded(id, msg.sender);
        }
    }

    /**
     * @notice Host (auction owner or current space owner) withdraws a protected booking that has a
     * winning bid, settled or not, after bidding closes and before parkingStart: the winner is
     * credited in full, without review.
     */
    function hostCancelBooking(uint256 id) external nonReentrant {
        Auction storage auction = _openBooking(id);
        if (!_isHost(id, msg.sender)) revert NotAuctionOwner();
        if (auction.highestBidder == address(0)) revert NoBidsToPayout();
        if (block.timestamp < auction.bidEnd) revert TooEarly();
        if (block.timestamp >= auction.parkingStart) revert TooLate();
        _refundWinner(id, Outcome.HostCancelled);
    }

    /**
     * @notice Host records a no-show from min(parkingStart + NO_SHOW_GRACE, parkingEnd) until the
     * report window closes. An attestation only: it changes no funds, deadlines or dispute rights.
     */
    function recordNoShow(uint256 id) external {
        Auction storage auction = _openBooking(id);
        if (!_isHost(id, msg.sender)) revert NotAuctionOwner();
        if (!auction.settled) revert NotSettled();
        Booking storage booking = bookings[id];
        if (booking.noShowRecorded || booking.lateCancelled) revert AlreadyRecorded();
        uint256 from = uint256(auction.parkingStart) + NO_SHOW_GRACE;
        if (from > auction.parkingEnd) from = auction.parkingEnd;
        if (block.timestamp < from) revert TooEarly();
        if (block.timestamp >= uint256(auction.parkingEnd) + REPORT_WINDOW) revert TooLate();
        booking.noShowRecorded = true;
        emit NoShowRecorded(id, msg.sender);
    }

    /**
     * @notice Winner or host reports a seller failure on a settled protected booking before
     * parkingEnd + REPORT_WINDOW. The principal is held until a resolver decides or the report
     * expires. `evidence` is an opaque reference to the off-chain review record, never the evidence.
     */
    function reportSellerFailure(uint256 id, bytes32 evidence) external {
        Auction storage auction = _openBooking(id);
        if (msg.sender != auction.highestBidder && !_isHost(id, msg.sender)) revert NotWinner();
        if (!auction.settled) revert NotSettled();
        if (evidence == bytes32(0)) revert InvalidEvidence();
        if (block.timestamp >= uint256(auction.parkingEnd) + REPORT_WINDOW) revert TooLate();
        Booking storage booking = bookings[id];
        if (booking.disputeReporter != address(0)) revert DisputeOpen();
        booking.disputeReporter = msg.sender;
        booking.disputeEvidence = evidence;
        emit DisputeOpened(id, msg.sender, evidence);
    }

    /**
     * @notice A resolver who is not a party upholds (winner credited in full) or denies (hold
     * released; the host claim still waits for parkingEnd + REPORT_WINDOW) an open report, before
     * parkingEnd + RESOLUTION_WINDOW. `decision` references the reason in the review record.
     */
    function resolveDispute(uint256 id, bool uphold, bytes32 decision) external nonReentrant {
        if (!resolvers[msg.sender]) revert NotResolver();
        Auction storage auction = _openBooking(id);
        if (msg.sender == auction.highestBidder || _isHost(id, msg.sender)) revert ResolverIsParty();
        if (bookings[id].disputeReporter == address(0)) revert NoOpenDispute();
        if (block.timestamp >= uint256(auction.parkingEnd) + RESOLUTION_WINDOW) revert TooLate();
        if (decision == bytes32(0)) revert InvalidEvidence();
        emit DisputeResolved(id, msg.sender, uphold, decision);
        if (uphold) {
            _refundWinner(id, Outcome.DisputeUpheld);
        } else {
            bookings[id].disputeReporter = address(0);
        }
    }

    /** @notice Credits the winner in full when a report is still open at parkingEnd + RESOLUTION_WINDOW. */
    function expireDispute(uint256 id) external nonReentrant {
        Auction storage auction = _openBooking(id);
        if (bookings[id].disputeReporter == address(0)) revert NoOpenDispute();
        if (block.timestamp < uint256(auction.parkingEnd) + RESOLUTION_WINDOW) revert TooEarly();
        _refundWinner(id, Outcome.DisputeExpired);
    }

    /** @dev The protected auction, reverting unless its principal is still undecided. */
    function _openBooking(uint256 id) private view returns (Auction storage auction) {
        auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (!bookings[id].isProtected) revert NotProtected();
        if (bookings[id].outcome != Outcome.None || auction.cancelled || auction.payoutClaimed) revert BookingFinalized();
    }

    function _isHost(uint256 id, address account) private view returns (bool) {
        return account == auctions[id].owner || account == spaceOwner[auctionSpace[id]];
    }

    /**
     * @dev Terminal winner credit. Marking the auction cancelled releases its window and keeps the
     * invariant: balance == sum(pendingReturns) + sum(highestBid of auctions neither cancelled nor paid).
     */
    function _refundWinner(uint256 id, Outcome outcome) private {
        Auction storage auction = auctions[id];
        Booking storage booking = bookings[id];
        booking.outcome = outcome;
        booking.disputeReporter = address(0);
        auction.cancelled = true;
        pendingReturns[auction.highestBidder] += auction.highestBid;
        emit BookingRefunded(id, auction.highestBidder, auction.highestBid, outcome);
    }
}
