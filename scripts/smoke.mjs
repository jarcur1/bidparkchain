import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { compileEscrowContract } from './helpers/compiler.mjs';
import {
  getProvider,
  getWallet,
  isNodeReachable,
  advanceTime,
  assertLocalChain,
  takeSnapshot,
  revertSnapshot,
} from './helpers/chain.mjs';

/**
 * Asserts that an async transaction or call reverts with the expected error name or message.
 * Strict check: fails if transaction succeeds or reverts with an unexpected error.
 */
async function assertReverts(promise, expectedError, stepName, contractInterface) {
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === 'function') {
      await tx.wait();
    }
    assert.fail(`[${stepName}] Expected transaction to revert with '${expectedError}', but it succeeded.`);
  } catch (err) {
    if (err.name === 'AssertionError') throw err;
    const errString = err.message || String(err);
    let matched = errString.includes(expectedError);

    if (!matched && contractInterface) {
      const data =
        err.data ||
        err.info?.error?.data ||
        err.error?.data ||
        (typeof err.data === 'object' && err.data?.data);

      if (typeof data === 'string' && data.startsWith('0x')) {
        try {
          const parsed = contractInterface.parseError(data);
          if (parsed && parsed.name === expectedError) {
            matched = true;
          }
        } catch {
          // ignore parse failure
        }
      }
    }

    if (!matched) {
      assert.fail(`[${stepName}] Expected revert with error '${expectedError}', but got: ${errString}`);
    }
    assert.ok(true, `Reverted as expected for ${stepName}`);
  }
}

async function runSmokeTests() {
  console.log('====================================================');
  console.log('  BidPark Smart Contract Live Smoke Test Suite');
  console.log('====================================================\n');

  const provider = getProvider();
  const reachable = await isNodeReachable();
  if (!reachable) {
    throw new Error('Local node is not reachable at http://127.0.0.1:8545. Please run `npm run chain` first.');
  }

  // Security check: verify connected network is strictly local testnet (31337)
  await assertLocalChain(provider);

  // Take EVM snapshot before smoke tests to isolate chain time and state
  const snapshotId = await takeSnapshot(provider);
  console.log(`[Setup] Captured EVM snapshot ${snapshotId} to preserve live node state.\n`);

  let testError = null;

  try {
    // Setup test accounts
    const seller = getWallet(0, provider);   // Auction Owner
    const buyer1 = getWallet(1, provider);   // First Bidder
    const buyer2 = getWallet(2, provider);   // Second Bidder (Outbidder)
    const intruder = getWallet(3, provider); // Unauthorized / Third Party

    console.log(`[Account Setup]`);
    console.log(`  Seller (Owner):    ${seller.address}`);
    console.log(`  Buyer 1:           ${buyer1.address}`);
    console.log(`  Buyer 2:           ${buyer2.address}`);
    console.log(`  Intruder/Guest:    ${intruder.address}\n`);

    // Compile and deploy fresh contract instance dedicated for smoke testing
    console.log('[1/11] Compiling and deploying fresh ParkingAuctionEscrow for smoke testing...');
    const { abi, bytecode } = compileEscrowContract();
    const factory = new ethers.ContractFactory(abi, bytecode, seller);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();
    console.log(`  ✓ Smoke test contract deployed at: ${contractAddress}`);

    // Test 1: Auction Creation with strict invariants
    console.log('\n[2/11] Testing auction creation and validation invariants...');
    const latestBlock = await provider.getBlock('latest');
    const now = latestBlock.timestamp;

    const validMetadataHash = ethers.keccak256(ethers.toUtf8Bytes('smoke-spot-001'));
    const minBid = ethers.parseEther('0.1');
    const bidEnd = now + 120; // 2 minutes
    const parkingStart = now + 200; // > bidEnd
    const parkingEnd = now + 600; // > parkingStart

    const createTx = await contract.createAuction(validMetadataHash, minBid, bidEnd, parkingStart, parkingEnd);
    const createReceipt = await createTx.wait();
    assert.ok(createReceipt.status === 1, 'Auction creation failed');

    const auction1 = await contract.auctions(1);
    assert.equal(auction1.owner, seller.address, 'Auction owner mismatch');
    assert.equal(auction1.minBid, minBid, 'MinBid mismatch');
    assert.equal(auction1.highestBid, 0n, 'Initial highestBid should be 0');
    assert.equal(auction1.highestBidder, ethers.ZeroAddress, 'Initial highestBidder should be zero address');
    assert.equal(auction1.settled, false, 'Auction should not be settled');
    assert.equal(auction1.cancelled, false, 'Auction should not be cancelled');
    assert.equal(auction1.payoutClaimed, false, 'Auction should not be payoutClaimed');
    console.log('  ✓ Auction #1 created successfully with verified invariant state');

    // Test 2: Initial Bid
    console.log('\n[3/11] Testing initial bid placement (Buyer 1)...');
    const contractBuyer1 = contract.connect(buyer1);
    const bidAmount1 = ethers.parseEther('0.15');
    const bidTx1 = await contractBuyer1.bid(1, { value: bidAmount1 });
    await bidTx1.wait();

    const auctionAfterBid1 = await contract.auctions(1);
    assert.equal(auctionAfterBid1.highestBidder, buyer1.address, 'Buyer 1 should be highest bidder');
    assert.equal(auctionAfterBid1.highestBid, bidAmount1, 'Highest bid amount mismatch');
    console.log(`  ✓ Buyer 1 placed highest bid of 0.15 ETH`);

    // Test 3: Outbidding and Pending Refund Accumulation
    console.log('\n[4/11] Testing outbidding and pending refund accounting (Buyer 2)...');
    const contractBuyer2 = contract.connect(buyer2);
    const bidAmount2 = ethers.parseEther('0.25');
    const bidTx2 = await contractBuyer2.bid(1, { value: bidAmount2 });
    await bidTx2.wait();

    const auctionAfterBid2 = await contract.auctions(1);
    assert.equal(auctionAfterBid2.highestBidder, buyer2.address, 'Buyer 2 should now be highest bidder');
    assert.equal(auctionAfterBid2.highestBid, bidAmount2, 'Highest bid should be 0.25 ETH');

    const buyer1Refund = await contract.pendingReturns(buyer1.address);
    assert.equal(buyer1Refund, bidAmount1, 'Buyer 1 pending refund should equal 0.15 ETH');
    console.log(`  ✓ Buyer 2 outbid Buyer 1. Buyer 1 pending return credited: ${ethers.formatEther(buyer1Refund)} ETH`);

    // Test 4: Refund Pull Withdrawal
    console.log('\n[5/11] Testing refund withdrawal (Buyer 1)...');
    const buyer1BalBefore = await provider.getBalance(buyer1.address);
    const withdrawTx = await contractBuyer1.withdrawRefund();
    const withdrawReceipt = await withdrawTx.wait();
    const gasSpent = withdrawReceipt.gasUsed * withdrawReceipt.gasPrice;
    const buyer1BalAfter = await provider.getBalance(buyer1.address);

    const expectedBal = buyer1BalBefore + buyer1Refund - gasSpent;
    assert.equal(buyer1BalAfter, expectedBal, 'Buyer 1 balance after refund mismatch');

    const buyer1RefundAfter = await contract.pendingReturns(buyer1.address);
    assert.equal(buyer1RefundAfter, 0n, 'Pending returns must reset to 0 after withdrawal');
    console.log('  ✓ Buyer 1 successfully withdrew refund. pendingReturns reset to 0');

    // Verify second immediate withdrawal fails with ZeroRefund
    await assertReverts(contractBuyer1.withdrawRefund(), 'ZeroRefund', 'Zero refund withdrawal', contract.interface);
    console.log('  ✓ Second consecutive withdrawal correctly reverted with ZeroRefund');

    // Test 5: Rebid by Same Bidder
    console.log('\n[6/11] Testing rebid by existing highest bidder (Buyer 2)...');
    const rebidAmount = ethers.parseEther('0.35');
    const rebidTx = await contractBuyer2.bid(1, { value: rebidAmount });
    await rebidTx.wait();

    const auctionAfterRebid = await contract.auctions(1);
    assert.equal(auctionAfterRebid.highestBid, rebidAmount, 'Highest bid should now be 0.35 ETH');
    const buyer2Refund = await contract.pendingReturns(buyer2.address);
    assert.equal(buyer2Refund, bidAmount2, 'Buyer 2 previous bid (0.25 ETH) should be credited to refund');
    console.log('  ✓ Same bidder rebid correctly updated highest bid and credited prior bid to refunds');

    // Buyer 2 withdraws their old bid refund
    const withdrawTx2 = await contractBuyer2.withdrawRefund();
    await withdrawTx2.wait();
    assert.equal(await contract.pendingReturns(buyer2.address), 0n);
    console.log('  ✓ Buyer 2 withdrew old bid refund');

    // Test 6: Active Bidding Edge Rejections
    console.log('\n[7/11] Testing active bidding rejection edges...');
    // Owner cannot bid
    await assertReverts(
      contract.bid(1, { value: ethers.parseEther('0.5') }),
      'OwnerCannotBid',
      'Owner bidding on own auction',
      contract.interface
    );
    console.log('  ✓ Owner bidding on own auction rejected (OwnerCannotBid)');

    // Bid below or equal to highest bid
    await assertReverts(
      contractBuyer1.bid(1, { value: ethers.parseEther('0.35') }),
      'BidTooLow',
      'Bid equal to highest bid',
      contract.interface
    );
    await assertReverts(
      contractBuyer1.bid(1, { value: ethers.parseEther('0.20') }),
      'BidTooLow',
      'Bid lower than highest bid',
      contract.interface
    );
    console.log('  ✓ Non-increasing bids rejected (BidTooLow)');

    // Owner cannot cancel auction with active bids
    await assertReverts(
      contract.cancel(1),
      'HasBidsCannotCancel',
      'Cancel auction with bids',
      contract.interface
    );
    console.log('  ✓ Cancellation of auction with active bids rejected (HasBidsCannotCancel)');

    // Premature settlement before bidEnd
    await assertReverts(
      contract.settle(1),
      'AuctionNotEnded',
      'Settlement before bidEnd',
      contract.interface
    );
    console.log('  ✓ Premature settlement rejected (AuctionNotEnded)');

    // Test 7: Time Advance Past bidEnd and Permissionless Settlement
    console.log('\n[8/11] Testing time advance past bidEnd and settlement...');
    await advanceTime(150, provider);

    // Bidding after bidEnd rejected
    await assertReverts(
      contractBuyer1.bid(1, { value: ethers.parseEther('0.5') }),
      'AuctionEnded',
      'Bidding after bidEnd',
      contract.interface
    );
    console.log('  ✓ Bidding after bidEnd rejected (AuctionEnded)');

    // Permissionless settlement called by guest/intruder
    const contractIntruder = contract.connect(intruder);
    const settleTx = await contractIntruder.settle(1);
    await settleTx.wait();

    const auctionSettled = await contract.auctions(1);
    assert.equal(auctionSettled.settled, true, 'Auction should be marked settled');
    assert.equal(auctionSettled.highestBidder, buyer2.address, 'Winning reservation belongs to Buyer 2');
    console.log('  ✓ Permissionless settlement executed. Winning reservation confirmed for Buyer 2');

    // Double settlement rejected
    await assertReverts(
      contract.settle(1),
      'AlreadySettled',
      'Double settlement',
      contract.interface
    );
    console.log('  ✓ Re-settlement rejected (AlreadySettled)');

    // Test 8: Parking Duration and Seller Payout
    console.log('\n[9/11] Testing parking period elapsed and seller payout claim...');
    // Payout before parkingEnd rejected
    await assertReverts(
      contract.claimPayout(1),
      'ParkingNotEnded',
      'Claim payout before parkingEnd',
      contract.interface
    );
    console.log('  ✓ Claim payout before parkingEnd rejected (ParkingNotEnded)');

    // Non-owner claim payout rejected
    await assertReverts(
      contractIntruder.claimPayout(1),
      'NotAuctionOwner',
      'Non-owner claim payout',
      contract.interface
    );
    console.log('  ✓ Non-owner claim payout rejected (NotAuctionOwner)');

    // Advance time past parkingEnd
    await advanceTime(500, provider);

    const sellerBalBefore = await provider.getBalance(seller.address);
    const payoutTx = await contract.claimPayout(1);
    const payoutReceipt = await payoutTx.wait();
    const payoutGas = payoutReceipt.gasUsed * payoutReceipt.gasPrice;
    const sellerBalAfter = await provider.getBalance(seller.address);

    const expectedSellerBal = sellerBalBefore + rebidAmount - payoutGas;
    assert.equal(sellerBalAfter, expectedSellerBal, 'Seller payout balance mismatch');

    const auctionPaid = await contract.auctions(1);
    assert.equal(auctionPaid.payoutClaimed, true, 'Payout should be marked claimed');
    console.log(`  ✓ Seller claimed payout of ${ethers.formatEther(rebidAmount)} ETH after parking ended`);

    // Double payout claim rejected
    await assertReverts(
      contract.claimPayout(1),
      'PayoutAlreadyClaimed',
      'Double payout claim',
      contract.interface
    );
    console.log('  ✓ Duplicate payout claim rejected (PayoutAlreadyClaimed)');

    // Test 9: No-bid Auction Cancellation
    console.log('\n[10/11] Testing no-bid auction cancellation...');
    const currentBlock2 = await provider.getBlock('latest');
    const now2 = currentBlock2.timestamp;
    const createTx2 = await contract.createAuction(
      ethers.keccak256(ethers.toUtf8Bytes('smoke-spot-002')),
      ethers.parseEther('0.05'),
      now2 + 100,
      now2 + 200,
      now2 + 500
    );
    await createTx2.wait();

    // Non-owner cancel rejected
    await assertReverts(
      contractIntruder.cancel(2),
      'NotAuctionOwner',
      'Non-owner cancel',
      contract.interface
    );
    console.log('  ✓ Non-owner cancellation rejected (NotAuctionOwner)');

    // Owner cancels no-bid auction
    const cancelTx = await contract.cancel(2);
    await cancelTx.wait();

    const auction2 = await contract.auctions(2);
    assert.equal(auction2.cancelled, true, 'Auction 2 should be cancelled');
    console.log('  ✓ Owner cancelled no-bid auction #2');

    // Bidding on cancelled auction rejected
    await assertReverts(
      contractBuyer1.bid(2, { value: ethers.parseEther('0.1') }),
      'AlreadyCancelled',
      'Bid on cancelled auction',
      contract.interface
    );
    console.log('  ✓ Bidding on cancelled auction rejected (AlreadyCancelled)');

    // Test 10: Creation Parameter Invariants
    console.log('\n[11/11] Testing parameter boundary rejection edges...');
    const block3 = await provider.getBlock('latest');
    const t = block3.timestamp;

    // Zero metadataHash
    await assertReverts(
      contract.createAuction(ethers.ZeroHash, ethers.parseEther('0.1'), t + 100, t + 200, t + 300),
      'InvalidMetadataHash',
      'Zero metadata hash',
      contract.interface
    );

    // Zero minBid
    await assertReverts(
      contract.createAuction(validMetadataHash, 0, t + 100, t + 200, t + 300),
      'InvalidMinBid',
      'Zero minBid',
      contract.interface
    );

    // bidEnd in past
    await assertReverts(
      contract.createAuction(validMetadataHash, ethers.parseEther('0.1'), t - 10, t + 200, t + 300),
      'InvalidTimeWindow',
      'Past bidEnd',
      contract.interface
    );

    // parkingStart < bidEnd
    await assertReverts(
      contract.createAuction(validMetadataHash, ethers.parseEther('0.1'), t + 200, t + 100, t + 300),
      'InvalidTimeWindow',
      'parkingStart < bidEnd',
      contract.interface
    );

    // parkingEnd <= parkingStart
    await assertReverts(
      contract.createAuction(validMetadataHash, ethers.parseEther('0.1'), t + 100, t + 200, t + 200),
      'InvalidTimeWindow',
      'parkingEnd <= parkingStart',
      contract.interface
    );

    console.log('  ✓ All invalid auction configuration parameters strictly rejected');

    console.log('\n====================================================');
    console.log('  ALL 11 SMOKE TESTS COMPLETED SUCCESSFULLY! ✓');
    console.log('====================================================\n');
  } catch (err) {
    testError = err;
  } finally {
    console.log('[Teardown] Restoring EVM snapshot to preserve demo chain timestamp and state...');
    let teardownError = null;
    try {
      const reverted = await revertSnapshot(snapshotId, provider);
      if (reverted !== true) {
        teardownError = new Error(`evm_revert returned false for snapshot ${snapshotId}`);
      } else {
        console.log('  ✓ Snapshot restored cleanly.');
      }
    } catch (revertErr) {
      teardownError = revertErr;
    }

    if (testError && teardownError) {
      console.error('\n❌ Both smoke tests and snapshot revert failed.');
      console.error('Test failure:', testError.message);
      console.error('Teardown failure:', teardownError.message);
      throw new Error(`Smoke test failed: ${testError.message} | Teardown failed: ${teardownError.message}`);
    } else if (testError) {
      throw testError;
    } else if (teardownError) {
      console.error('\n❌ Smoke teardown failed: Snapshot restoration error:');
      throw teardownError;
    }
  }
}

runSmokeTests().catch((err) => {
  console.error('\n❌ Smoke test failed:', err);
  process.exit(1);
});
