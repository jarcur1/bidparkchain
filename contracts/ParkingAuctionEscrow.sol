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

    // Events
    event AuctionCreated(uint256 indexed id, address indexed owner);
    event BidPlaced(uint256 indexed id, address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed recipient, uint256 amount);
    event AuctionSettled(uint256 indexed id, address indexed winner, uint256 amount);
    event PayoutClaimed(uint256 indexed id, address indexed owner, uint256 amount);
    event AuctionCancelled(uint256 indexed id);

    modifier nonReentrant() {
        if (_status == 2) revert ReentrantCall();
        _status = 2;
        _;
        _status = 1;
    }

    /**
     * @notice Creates a new parking auction with escrow invariants.
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
     * @notice Cancels an auction before any bids have been received.
     */
    function cancel(uint256 id) external nonReentrant {
        Auction storage auction = auctions[id];
        if (auction.owner == address(0)) revert AuctionNotFound();
        if (msg.sender != auction.owner) revert NotAuctionOwner();
        if (auction.settled) revert AlreadySettled();
        if (auction.cancelled) revert AlreadyCancelled();
        if (auction.highestBidder != address(0) || auction.highestBid > 0) revert HasBidsCannotCancel();

        auction.cancelled = true;

        emit AuctionCancelled(id);
    }
}
