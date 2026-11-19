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

    modifier nonReentrant() {
        if (_status == 2) revert ReentrantCall();
        _status = 2;
        _;
        _status = 1;
    }

    modifier onlySpaceOwner(uint256 spaceId) {
        if (spaceOwner[spaceId] != msg.sender) revert NotSpaceOwner();
        _;
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
        if (!isSpaceLister(spaceId, msg.sender)) revert NotSpaceOwner();
        _checkWindowFree(spaceId, parkingStart, parkingEnd);
        id = _createAuction(spaceId, metadataHash, minBid, bidEnd, parkingStart, parkingEnd);
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

        auction.settled = true;

        emit AuctionSettled(id, auction.highestBidder, auction.highestBid);
    }

    /**
     * @notice Seller claims payout after parkingEnd has elapsed.
     */
    function claimPayout(uint256 id) external nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (msg.sender != auction.owner) revert NotAuctionOwner();
        if (!auction.settled) revert NotSettled();
        if (block.timestamp < auction.parkingEnd) revert ParkingNotEnded();
        if (auction.payoutClaimed) revert PayoutAlreadyClaimed();
        if (auction.highestBidder == address(0) || auction.highestBid == 0) revert NoBidsToPayout();

        auction.payoutClaimed = true;
        uint256 payout = auction.highestBid;

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
}
