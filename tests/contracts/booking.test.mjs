import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createScope, deployEscrow } from '../support/owned-env.mjs';
import { recipientArtifact } from './fixture-compiler.mjs';

// Protected bookings (protocol version 2): docs/booking-policy.md.
const hash = ethers.id('protected-parking');
const evidence = ethers.id('review-record-1');
const decision = ethers.id('decision-1');
const eth = ethers.parseEther;
const HOUR = 3600;
const DAY = 24 * HOUR;
const Outcome = { None: 0n, WinnerCancelled: 1n, HostCancelled: 2n, Expired: 3n, DisputeUpheld: 4n, DisputeExpired: 5n, HostPaid: 6n };

let scope, chain, escrow, host, alice, bob, guest, resolver;
const mined = async (promise) => (await promise).wait();
const balance = async (address) => BigInt(await chain.provider.send('eth_getBalance', [address, 'latest']));
const timestamp = async () => Number((await chain.provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
const nextTime = async (time) => chain.provider.send('evm_setNextBlockTimestamp', [Number(time)]);
const mineAt = async (time) => { await nextTime(time); await chain.provider.send('evm_mine', []); };

async function reverts(promise, name) {
  let failure;
  try { await promise; } catch (error) { failure = error; }
  expect(failure, `Expected ${name}`).toBeDefined();
  const candidates = [failure.data, failure.data?.data, failure.info?.error?.data, failure.info?.error?.data?.data, failure.error?.data];
  const data = candidates.find((value) => typeof value === 'string' && value.startsWith('0x'));
  expect(data, `Missing structured revert data for ${name}`).toBeDefined();
  expect(escrow.interface.parseError(data)?.name).toBe(name);
}

/** A protected auction whose parking starts two days after bidding closes, unless told otherwise. */
async function create({ signer = host, spaceId = 0, bidEnd, parkingStart, parkingEnd } = {}) {
  const now = await timestamp();
  bidEnd ??= now + 1000;
  parkingStart ??= bidEnd + 2 * DAY;
  parkingEnd ??= parkingStart + 2 * HOUR;
  const id = await escrow.nextAuctionId();
  await mined(escrow.connect(signer).createProtectedAuction(spaceId, hash, eth('0.1'), bidEnd, parkingStart, parkingEnd));
  return { id, bidEnd, parkingStart, parkingEnd };
}
const outcome = async (id) => (await escrow.bookings(id)).outcome;

beforeAll(async () => {
  scope = await createScope('contracts');
  chain = await scope.startChain();
  [host, alice, bob, guest, resolver] = [0, 1, 2, 3, 4].map((i) => chain.wallet(i));
});
afterAll(async () => {
  try { await scope?.close(); } finally { chain?.provider.destroy(); }
});
beforeEach(async () => {
  ({ contract: escrow } = await deployEscrow(chain));
  await mined(escrow.setResolver(resolver.address, true));
});

describe('protected booking dispositions', () => {
  it('conserves ETH through every terminal disposition and pays each principal exactly once', async () => {
    const people = [host, alice, bob, guest, resolver];
    const initial = await Promise.all(people.map(({ address }) => balance(address)));
    const flows = people.map(() => 0n);
    const gas = people.map(() => 0n);
    const ids = [];
    async function check() {
      let liabilities = 0n;
      for (const { address } of people) liabilities += await escrow.pendingReturns(address);
      for (const id of ids) {
        const auction = await escrow.auctions(id);
        if (!auction.payoutClaimed && !auction.cancelled) liabilities += auction.highestBid;
      }
      expect(await balance(await escrow.getAddress())).toBe(liabilities);
      for (let i = 0; i < people.length; i++) expect(await balance(people[i].address)).toBe(initial[i] + flows[i] - gas[i]);
    }
    async function step(signer, promise, flow = 0n) {
      const receipt = await mined(promise);
      const i = people.indexOf(signer);
      gas[i] += receipt.gasUsed * receipt.gasPrice;
      flows[i] += flow;
      await check();
      return receipt;
    }

    const now = await timestamp();
    const B = now + 1000, S = B + 2 * DAY, E = S + 2 * HOUR;
    // 1 early winner cancel, 2 host cancel unsettled, 3 host cancel settled, 4 expired unsettled,
    // 5 dispute upheld, 6 dispute expired, 7 late cancel + denied dispute + host payout, 8 version 1.
    for (let n = 1; n <= 7; n++) {
      ids.push(BigInt(n));
      await step(host, escrow.createProtectedAuction(0, hash, eth('0.1'), B, S, E));
    }
    ids.push(8n);
    await step(host, escrow.createAuction(hash, eth('0.1'), B, S, E));
    expect((await escrow.bookings(8)).isProtected).toBe(false);
    for (const id of ids) {
      await step(bob, escrow.connect(bob).bid(id, { value: eth('0.1') }), -eth('0.1'));
      await step(alice, escrow.connect(alice).bid(id, { value: eth('0.2') + id }), -(eth('0.2') + id));
    }
    const principal = (id) => eth('0.2') + BigInt(id);

    await mineAt(B);
    for (const id of [1, 3, 5, 6, 7, 8]) await step(guest, escrow.connect(guest).settle(id));
    await step(alice, escrow.connect(alice).cancelBooking(1));
    expect(await outcome(1)).toBe(Outcome.WinnerCancelled);
    await step(host, escrow.hostCancelBooking(2));
    await step(host, escrow.hostCancelBooking(3));
    expect([await outcome(2), await outcome(3)]).toEqual([Outcome.HostCancelled, Outcome.HostCancelled]);

    await mineAt(S - HOUR);
    await step(alice, escrow.connect(alice).cancelBooking(7));
    expect((await escrow.bookings(7)).lateCancelled).toBe(true);
    expect(await outcome(7)).toBe(Outcome.None);

    await nextTime(S);
    await step(guest, escrow.connect(guest).expire(4));
    expect(await outcome(4)).toBe(Outcome.Expired);
    await mineAt(S + 30 * 60);
    await step(host, escrow.recordNoShow(6));

    await mineAt(E);
    await step(alice, escrow.connect(alice).reportSellerFailure(5, evidence));
    await step(host, escrow.reportSellerFailure(6, evidence));
    await step(alice, escrow.connect(alice).reportSellerFailure(7, evidence));
    await step(resolver, escrow.connect(resolver).resolveDispute(5, true, decision));
    await step(resolver, escrow.connect(resolver).resolveDispute(7, false, decision));
    expect([await outcome(5), await outcome(7)]).toEqual([Outcome.DisputeUpheld, Outcome.None]);

    await mineAt(E + DAY);
    await reverts(escrow.claimPayout.staticCall(6), 'DisputeOpen');
    await step(host, escrow.claimPayout(7));
    await step(host, escrow.claimPayout(8), principal(8)); // version 1 still pays directly
    expect(await outcome(7)).toBe(Outcome.HostPaid);

    await mineAt(E + 3 * DAY);
    await reverts(escrow.connect(resolver).resolveDispute.staticCall(6, false, decision), 'TooLate');
    await step(bob, escrow.connect(bob).expireDispute(6));
    expect(await outcome(6)).toBe(Outcome.DisputeExpired);

    // Exactly one disposition per principal: winner credited for 1-6, host for 7 (8 already paid).
    const winnerCredit = [1, 2, 3, 4, 5, 6].reduce((sum, id) => sum + principal(id), 0n);
    expect(await escrow.pendingReturns(alice.address)).toBe(winnerCredit);
    expect(await escrow.pendingReturns(host.address)).toBe(principal(7));
    expect(await escrow.pendingReturns(bob.address)).toBe(eth('0.1') * 8n);
    for (const id of ids.slice(0, 7)) {
      for (const call of [
        () => escrow.connect(alice).cancelBooking.staticCall(id),
        () => escrow.hostCancelBooking.staticCall(id),
        () => escrow.connect(alice).reportSellerFailure.staticCall(id, evidence),
        () => escrow.connect(resolver).resolveDispute.staticCall(id, true, decision),
        () => escrow.expireDispute.staticCall(id),
        () => escrow.expire.staticCall(id),
      ]) await reverts(call(), 'BookingFinalized');
    }
    for (const id of [1, 2, 3, 4, 5]) await reverts(escrow.claimPayout.staticCall(id), id === 2 || id === 4 ? 'NotSettled' : 'BookingFinalized');
    await reverts(escrow.claimPayout.staticCall(7), 'PayoutAlreadyClaimed');

    await step(alice, escrow.connect(alice).withdrawRefund(), winnerCredit);
    await step(bob, escrow.connect(bob).withdrawRefund(), eth('0.8'));
    await step(host, escrow.withdrawRefund(), principal(7));
    expect(await balance(await escrow.getAddress())).toBe(0n);
  });

  it('lets a new report follow a denial before the report deadline, and expires an unresolved one', async () => {
    const { id, bidEnd, parkingEnd } = await create();
    await mined(escrow.connect(alice).bid(id, { value: eth('0.3') }));
    await mineAt(bidEnd);
    await mined(escrow.settle(id));
    await mined(escrow.connect(alice).reportSellerFailure(id, evidence));
    await reverts(escrow.reportSellerFailure.staticCall(id, evidence), 'DisputeOpen');
    await mined(escrow.connect(resolver).resolveDispute(id, false, decision));
    // A denial does not shorten the hold.
    await reverts(escrow.claimPayout.staticCall(id), 'ParkingNotEnded');
    await mineAt(parkingEnd + DAY - 2);
    await mined(escrow.connect(alice).reportSellerFailure(id, ethers.id('more evidence')));
    expect((await escrow.bookings(id)).disputeReporter).toBe(alice.address);
    await mineAt(parkingEnd + DAY);
    await reverts(escrow.claimPayout.staticCall(id), 'DisputeOpen');
    await mineAt(parkingEnd + 3 * DAY - 1);
    await reverts(escrow.expireDispute.staticCall(id), 'TooEarly');
    await mineAt(parkingEnd + 3 * DAY);
    await reverts(escrow.connect(resolver).resolveDispute.staticCall(id, true, decision), 'TooLate');
    await mined(escrow.connect(guest).expireDispute(id));
    expect(await outcome(id)).toBe(Outcome.DisputeExpired);
    expect(await escrow.pendingReturns(alice.address)).toBe(eth('0.3'));
  });
});

describe('roles and authority', () => {
  it('limits each action to its party and keeps version 1 auctions on version 1 rules', async () => {
    const { id, bidEnd } = await create();
    await mined(escrow.connect(alice).bid(id, { value: eth('0.2') }));
    await mineAt(bidEnd);
    await mined(escrow.settle(id));
    await reverts(escrow.connect(bob).cancelBooking.staticCall(id), 'NotWinner');
    await reverts(escrow.cancelBooking.staticCall(id), 'NotWinner');
    for (const signer of [alice, guest, resolver]) await reverts(escrow.connect(signer).hostCancelBooking.staticCall(id), 'NotAuctionOwner');
    await reverts(escrow.connect(guest).reportSellerFailure.staticCall(id, evidence), 'NotWinner');
    await reverts(escrow.connect(alice).reportSellerFailure.staticCall(id, ethers.ZeroHash), 'InvalidEvidence');
    await mined(escrow.connect(alice).reportSellerFailure(id, evidence));
    for (const signer of [guest, alice, bob]) await reverts(escrow.connect(signer).resolveDispute.staticCall(id, true, decision), 'NotResolver');
    await reverts(escrow.connect(resolver).resolveDispute.staticCall(id, true, ethers.ZeroHash), 'InvalidEvidence');
    // Only the deployer manages resolvers, and a resolver can never decide its own booking.
    await reverts(escrow.connect(alice).setResolver.staticCall(alice.address, true), 'NotResolver');
    expect(await escrow.resolverAdmin()).toBe(host.address);
    await mined(escrow.setResolver(alice.address, true));
    await mined(escrow.setResolver(host.address, true));
    await reverts(escrow.connect(alice).resolveDispute.staticCall(id, true, decision), 'ResolverIsParty');
    await reverts(escrow.resolveDispute.staticCall(id, false, decision), 'ResolverIsParty');
    await mined(escrow.setResolver(resolver.address, false));
    await reverts(escrow.connect(resolver).resolveDispute.staticCall(id, true, decision), 'NotResolver');

    const now = await timestamp();
    await mined(escrow.createAuction(hash, 1, now + 100, now + 100, now + 200));
    const legacy = (await escrow.nextAuctionId()) - 1n;
    for (const call of [
      () => escrow.hostCancelBooking.staticCall(legacy),
      () => escrow.connect(alice).cancelBooking.staticCall(legacy),
      () => escrow.expire.staticCall(legacy),
      () => escrow.recordNoShow.staticCall(legacy),
      () => escrow.reportSellerFailure.staticCall(legacy, evidence),
      () => escrow.expireDispute.staticCall(legacy),
    ]) await reverts(call(), 'NotProtected');
    for (const method of ['expire', 'cancelBooking', 'hostCancelBooking', 'recordNoShow', 'expireDispute']) {
      await reverts(escrow[method].staticCall(999), 'AuctionNotFound');
    }
  });

  it('lets the space owner withdraw a delegated lister booking, refunding the winner', async () => {
    const spaceId = await escrow.nextSpaceId();
    await mined(escrow.registerSpace());
    await mined(escrow.setSpaceLister(spaceId, bob.address, true));
    const { id, bidEnd } = await create({ signer: bob, spaceId });
    expect(await escrow.auctionSpace(id)).toBe(spaceId);
    await mined(escrow.connect(alice).bid(id, { value: eth('0.2') }));
    await mineAt(bidEnd);
    await mined(escrow.hostCancelBooking(id));
    expect(await outcome(id)).toBe(Outcome.HostCancelled);
    expect(await escrow.holdsWindow(id)).toBe(false);
    expect(await escrow.pendingReturns(alice.address)).toBe(eth('0.2'));
  });
});

describe('exact deadline boundaries', () => {
  it('requires a 30 minute bid lead and settles only before parking starts', async () => {
    const now = await timestamp();
    await reverts(escrow.createProtectedAuction.staticCall(0, hash, 1, now + 100, now + 100 + 1799, now + 5000), 'InvalidTimeWindow');
    const a = await create({ bidEnd: now + 100, parkingStart: now + 1900, parkingEnd: now + 5000 });
    const b = await create({ bidEnd: now + 100, parkingStart: now + 1900, parkingEnd: now + 5000 });
    const empty = await create({ bidEnd: now + 100, parkingStart: now + 1900, parkingEnd: now + 5000 });
    for (const { id } of [a, b]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(now + 1898);
    await reverts(escrow.expire.staticCall(b.id), 'TooEarly');
    await nextTime(now + 1899);
    await mined(escrow.settle(a.id));
    await mineAt(now + 1900);
    await reverts(escrow.settle.staticCall(b.id), 'TooLate');
    await mined(escrow.settle(empty.id)); // a no-bid outcome can always be finalized
    await reverts(escrow.expire.staticCall(a.id), 'AlreadySettled');
    await reverts(escrow.expire.staticCall(empty.id), 'AlreadySettled');
    await mined(escrow.expire(b.id));
    expect(await outcome(b.id)).toBe(Outcome.Expired);
  });

  it('refunds a winner cancellation exactly at start - 24h and only records it one second later', async () => {
    const early = await create();
    const late = await create({ bidEnd: early.bidEnd, parkingStart: early.parkingStart, parkingEnd: early.parkingEnd });
    for (const { id } of [early, late]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(early.bidEnd);
    await reverts(escrow.connect(alice).cancelBooking.staticCall(early.id), 'NotSettled');
    for (const { id } of [early, late]) await mined(escrow.settle(id));
    await nextTime(early.parkingStart - DAY);
    await mined(escrow.connect(alice).cancelBooking(early.id));
    await nextTime(early.parkingStart - DAY + 1);
    await mined(escrow.connect(alice).cancelBooking(late.id));
    expect(await outcome(early.id)).toBe(Outcome.WinnerCancelled);
    expect(await outcome(late.id)).toBe(Outcome.None);
    expect((await escrow.bookings(late.id)).lateCancelled).toBe(true);
    await reverts(escrow.connect(alice).cancelBooking.staticCall(late.id), 'AlreadyRecorded');
    await reverts(escrow.recordNoShow.staticCall(late.id), 'AlreadyRecorded');
    expect(await escrow.pendingReturns(alice.address)).toBe(eth('0.1'));
    await mineAt(early.parkingStart);
    await reverts(escrow.connect(alice).cancelBooking.staticCall(late.id), 'TooLate');
  });

  it('allows host cancellation from bidEnd until parkingStart, only with a winning bid', async () => {
    const a = await create();
    const b = await create({ bidEnd: a.bidEnd, parkingStart: a.parkingStart, parkingEnd: a.parkingEnd });
    const empty = await create({ bidEnd: a.bidEnd, parkingStart: a.parkingStart, parkingEnd: a.parkingEnd });
    for (const { id } of [a, b]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(a.bidEnd - 1);
    await reverts(escrow.hostCancelBooking.staticCall(a.id), 'TooEarly');
    await reverts(escrow.cancel.staticCall(a.id), 'HasBidsCannotCancel');
    await reverts(escrow.hostCancelBooking.staticCall(empty.id), 'NoBidsToPayout');
    await nextTime(a.parkingStart - 1);
    await mined(escrow.hostCancelBooking(a.id));
    await mineAt(a.parkingStart);
    await reverts(escrow.hostCancelBooking.staticCall(b.id), 'TooLate');
  });

  it('opens the no-show attestation at min(start + 30m, end) and closes it with the report window', async () => {
    const now = await timestamp();
    const long = await create({ bidEnd: now + 100, parkingStart: now + 2000, parkingEnd: now + 9000 });
    const short = await create({ bidEnd: now + 100, parkingStart: now + 2000, parkingEnd: now + 2600 });
    for (const { id } of [long, short]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(now + 100);
    for (const { id } of [long, short]) await mined(escrow.settle(id));
    await mineAt(now + 2599);
    await reverts(escrow.recordNoShow.staticCall(short.id), 'TooEarly');
    await reverts(escrow.recordNoShow.staticCall(long.id), 'TooEarly');
    await nextTime(now + 2600);
    await mined(escrow.recordNoShow(short.id)); // N = parkingEnd for a 10 minute booking
    await reverts(escrow.recordNoShow.staticCall(short.id), 'AlreadyRecorded');
    await reverts(escrow.connect(alice).recordNoShow.staticCall(long.id), 'NotAuctionOwner');
    await mineAt(now + 2000 + 1799);
    await reverts(escrow.recordNoShow.staticCall(long.id), 'TooEarly');
    await mineAt(now + 9000 + DAY);
    await reverts(escrow.recordNoShow.staticCall(long.id), 'TooLate');
    // A no-show changes nothing about the principal: the host still waits for the normal claim time.
    expect(await outcome(short.id)).toBe(Outcome.None);
    expect((await escrow.bookings(short.id)).noShowRecorded).toBe(true);
  });

  it('closes reports and opens the host claim at exactly end + 24h; resolution ends at end + 72h', async () => {
    const a = await create();
    const b = await create({ bidEnd: a.bidEnd, parkingStart: a.parkingStart, parkingEnd: a.parkingEnd });
    for (const { id } of [a, b]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(a.bidEnd);
    for (const { id } of [a, b]) await mined(escrow.settle(id));
    await mineAt(a.parkingEnd + DAY - 2);
    await reverts(escrow.claimPayout.staticCall(a.id), 'TooEarly');
    await nextTime(a.parkingEnd + DAY - 1);
    await mined(escrow.connect(alice).reportSellerFailure(b.id, evidence));
    await mineAt(a.parkingEnd + DAY);
    await reverts(escrow.connect(alice).reportSellerFailure.staticCall(a.id, evidence), 'TooLate');
    await mined(escrow.claimPayout(a.id));
    expect(await escrow.pendingReturns(host.address)).toBe(eth('0.1'));
    await mineAt(a.parkingEnd + 3 * DAY - 2);
    await reverts(escrow.expireDispute.staticCall(b.id), 'TooEarly');
    await nextTime(a.parkingEnd + 3 * DAY - 1);
    await mined(escrow.connect(resolver).resolveDispute(b.id, true, decision));
    expect(await outcome(b.id)).toBe(Outcome.DisputeUpheld);
    await reverts(escrow.connect(resolver).resolveDispute.staticCall(b.id, false, decision), 'BookingFinalized');
  });

  it('never lets a report and a host claim both succeed around the deadline, even in one block', async () => {
    const a = await create();
    const b = await create({ bidEnd: a.bidEnd, parkingStart: a.parkingStart, parkingEnd: a.parkingEnd });
    for (const { id } of [a, b]) await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(a.bidEnd);
    for (const { id } of [a, b]) await mined(escrow.settle(id));
    const status = async (tx) => (await chain.provider.getTransactionReceipt(tx.hash)).status;
    const opts = { gasLimit: 300_000 };
    await chain.provider.send('evm_setAutomine', [false]);
    try {
      await nextTime(a.parkingEnd + DAY - 1);
      const report = await escrow.connect(alice).reportSellerFailure(a.id, evidence, opts);
      const earlyClaim = await escrow.claimPayout(b.id, opts);
      await chain.provider.send('evm_mine', []);
      expect([await status(report), await status(earlyClaim)]).toEqual([1, 0]);
      await nextTime(a.parkingEnd + DAY);
      const lateReport = await escrow.connect(alice).reportSellerFailure(b.id, evidence, opts);
      const claim = await escrow.claimPayout(b.id, opts);
      const heldClaim = await escrow.claimPayout(a.id, opts);
      await chain.provider.send('evm_mine', []);
      expect([await status(lateReport), await status(claim), await status(heldClaim)]).toEqual([0, 1, 0]);
    } finally {
      await chain.provider.send('evm_setAutomine', [true]);
    }
    expect((await escrow.bookings(a.id)).disputeReporter).toBe(alice.address);
    expect(await outcome(b.id)).toBe(Outcome.HostPaid);
  });
});

describe('pull payments only', () => {
  async function recipient() {
    const { abi, bytecode } = recipientArtifact();
    const actor = await new ethers.ContractFactory(abi, bytecode, host).deploy(await escrow.getAddress());
    await actor.waitForDeployment();
    return actor;
  }
  const encoded = (method, args = []) => escrow.interface.encodeFunctionData(method, args);

  it('credits a rejecting host and a reentrant winner without sending ETH during any transition', async () => {
    const actorHost = await recipient();
    const actorWinner = await recipient();
    const now = await timestamp();
    const B = now + 1000, S = B + 2 * DAY, E = S + HOUR;
    await mined(actorHost.execute(encoded('createProtectedAuction', [0, hash, 1, B, S, E])));
    await mined(actorHost.execute(encoded('createProtectedAuction', [0, hash, 1, B, S, E])));
    await mined(actorWinner.execute(encoded('bid', [1]), { value: eth('0.2') }));
    await mined(escrow.connect(alice).bid(2, { value: eth('0.3') }));
    await mined(actorHost.configure(true, '0x', false)); // rejects all ETH
    await mined(actorWinner.configure(false, encoded('withdrawRefund'), true)); // reenters on receipt
    await mineAt(B);
    await mined(escrow.settle(1));
    await mined(escrow.settle(2));
    await mined(actorHost.execute(encoded('hostCancelBooking', [1])));
    expect(await escrow.pendingReturns(await actorWinner.getAddress())).toBe(eth('0.2'));
    expect(await actorWinner.received()).toBe(0n);
    await mineAt(E + DAY);
    await mined(actorHost.execute(encoded('claimPayout', [2]))); // succeeds although the host rejects ETH
    expect(await escrow.pendingReturns(await actorHost.getAddress())).toBe(eth('0.3'));
    await reverts(actorHost.execute.staticCall(encoded('withdrawRefund')), 'TransferFailed');
    await mined(actorWinner.execute(encoded('withdrawRefund')));
    expect(await actorWinner.lastError()).toBe(escrow.interface.getError('ReentrantCall').selector);
    expect(await actorWinner.received()).toBe(eth('0.2'));
    expect(await escrow.pendingReturns(await actorWinner.getAddress())).toBe(0n);
    await mined(actorHost.configure(false, '0x', false));
    await mined(actorHost.execute(encoded('withdrawRefund')));
    expect(await actorHost.received()).toBe(eth('0.3'));
    expect(await balance(await escrow.getAddress())).toBe(0n);
  });
});
