import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createScope, deployEscrow } from '../support/owned-env.mjs';
import { recipientArtifact } from './fixture-compiler.mjs';

const hash = ethers.id('isolated-parking');
const eth = ethers.parseEther;
let scope, chain, escrow, owner, alice, bob, guest;
const mined = async (promise) => (await promise).wait();
const balance = async (address) => BigInt(await chain.provider.send('eth_getBalance', [address, 'latest']));
const timestamp = async () => Number((await chain.provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
const nextTime = async (time) => chain.provider.send('evm_setNextBlockTimestamp', [Number(time)]);
const mineAt = async (time) => { await nextTime(time); await chain.provider.send('evm_mine', []); };

// Decode structured revert data with the actual ABI, never provider message text.
async function reverts(promise, name) {
  let failure;
  try { await promise; } catch (error) { failure = error; }
  expect(failure, `Expected ${name}`).toBeDefined();
  const candidates = [failure.data, failure.data?.data, failure.info?.error?.data, failure.info?.error?.data?.data, failure.error?.data];
  const data = candidates.find((value) => typeof value === 'string' && value.startsWith('0x'));
  expect(data, 'Missing structured revert data').toBeDefined();
  expect(escrow.interface.parseError(data)?.name).toBe(name);
}

async function create({ signer = owner, minBid = eth('0.1'), bidEnd, parkingStart, parkingEnd } = {}) {
  const now = await timestamp();
  bidEnd ??= now + 1000;
  parkingStart ??= bidEnd + 100;
  parkingEnd ??= parkingStart + 100;
  const id = await escrow.nextAuctionId();
  await mined(escrow.connect(signer).createAuction(hash, minBid, bidEnd, parkingStart, parkingEnd));
  return { id, bidEnd, parkingStart, parkingEnd };
}

beforeAll(async () => {
  scope = await createScope('contracts');
  chain = await scope.startChain();
  [owner, alice, bob, guest] = [0, 1, 2, 3].map((i) => chain.wallet(i));
});
afterAll(async () => {
  try { await scope?.close(); } finally { chain?.provider.destroy(); }
});
beforeEach(async () => { ({ contract: escrow } = await deployEscrow(chain)); });

describe('auction accounting and lifecycle (ported smoke scenarios)', () => {
  it('conserves ETH at every step across auctions, outbids, self-rebids, refunds, cancellation and payouts', async () => {
    const participants = [owner, alice, bob, guest];
    const initial = await Promise.all(participants.map(({ address }) => balance(address)));
    const flows = participants.map(() => 0n);
    const gas = participants.map(() => 0n);
    const ids = [];
    async function check() {
      let liabilities = 0n;
      for (const { address } of participants) liabilities += await escrow.pendingReturns(address);
      for (const id of ids) {
        const auction = await escrow.auctions(id);
        // highestBid is retained after payout; settlement alone does NOT release escrow.
        // Cancellation is allowed only with zero bids, hence adds no liability.
        if (!auction.payoutClaimed && !auction.cancelled) liabilities += auction.highestBid;
      }
      expect(await balance(await escrow.getAddress())).toBe(liabilities);
      for (let i = 0; i < participants.length; i++) {
        expect(await balance(participants[i].address)).toBe(initial[i] + flows[i] - gas[i]);
      }
    }
    async function step(index, promise, flow = 0n) {
      const receipt = await mined(promise);
      gas[index] += receipt.gasUsed * receipt.gasPrice;
      flows[index] += flow;
      await check();
      return receipt;
    }
    const now = await timestamp();
    for (let id = 1n; id <= 3n; id++) {
      ids.push(id);
      await step(0, escrow.createAuction(hash, eth('0.1'), now + 1000, now + 1100, now + 1200));
    }
    const first = await escrow.auctions(1);
    expect(first.owner).toBe(owner.address);
    expect(first.metadataHash).toBe(hash);
    expect(first.minBid).toBe(eth('0.1'));
    expect(first.highestBid).toBe(0n);
    expect(first.highestBidder).toBe(ethers.ZeroAddress);
    expect([first.settled, first.cancelled, first.payoutClaimed]).toEqual([false, false, false]);
    await step(1, escrow.connect(alice).bid(1, { value: eth('0.15') }), -eth('0.15'));
    await step(2, escrow.connect(bob).bid(1, { value: eth('0.25') }), -eth('0.25'));
    expect(await escrow.pendingReturns(alice.address)).toBe(eth('0.15'));
    await step(1, escrow.connect(alice).bid(2, { value: eth('0.2') }), -eth('0.2'));
    await step(2, escrow.connect(bob).bid(1, { value: eth('0.35') }), -eth('0.35'));
    expect(await escrow.pendingReturns(bob.address)).toBe(eth('0.25'));
    await step(3, escrow.connect(guest).bid(2, { value: eth('0.3') }), -eth('0.3'));
    expect(await escrow.pendingReturns(alice.address)).toBe(eth('0.35'));
    await step(1, escrow.connect(alice).withdrawRefund(), eth('0.35'));
    await reverts(escrow.connect(alice).withdrawRefund.staticCall(), 'ZeroRefund');
    await step(2, escrow.connect(bob).withdrawRefund(), eth('0.25'));
    await step(0, escrow.cancel(3));
    await mineAt(now + 1000);
    await step(3, escrow.connect(guest).settle(1));
    expect((await escrow.auctions(1)).highestBidder).toBe(bob.address);
    await step(2, escrow.connect(bob).settle(2));
    await mineAt(now + 1200);
    await step(0, escrow.claimPayout(1), eth('0.35'));
    await step(0, escrow.claimPayout(2), eth('0.3'));
    expect((await escrow.auctions(1)).payoutClaimed).toBe(true);
    expect(await balance(await escrow.getAddress())).toBe(0n);
  });

  it('rejects unauthorized, non-increasing, duplicate and terminal-state actions', async () => {
    const { id, bidEnd, parkingEnd } = await create();
    await reverts(escrow.claimPayout.staticCall(id), 'NotSettled');
    await reverts(escrow.connect(guest).cancel.staticCall(id), 'NotAuctionOwner');
    await reverts(escrow.bid.staticCall(id, { value: eth('1') }), 'OwnerCannotBid');
    await reverts(escrow.connect(alice).bid.staticCall(id, { value: eth('0.09') }), 'BidTooLow');
    await mined(escrow.connect(alice).bid(id, { value: eth('0.35') }));
    for (const value of ['0.35', '0.20']) await reverts(escrow.connect(bob).bid.staticCall(id, { value: eth(value) }), 'BidTooLow');
    await reverts(escrow.cancel.staticCall(id), 'HasBidsCannotCancel');
    await reverts(escrow.settle.staticCall(id), 'AuctionNotEnded');
    await mineAt(bidEnd);
    await reverts(escrow.connect(bob).bid.staticCall(id, { value: eth('0.5') }), 'AuctionEnded');
    await mined(escrow.connect(guest).settle(id));
    await reverts(escrow.settle.staticCall(id), 'AlreadySettled');
    await reverts(escrow.cancel.staticCall(id), 'AlreadySettled');
    await reverts(escrow.connect(bob).bid.staticCall(id, { value: eth('0.5') }), 'AlreadySettled');
    await reverts(escrow.claimPayout.staticCall(id), 'ParkingNotEnded');
    await reverts(escrow.connect(guest).claimPayout.staticCall(id), 'NotAuctionOwner');
    await mineAt(parkingEnd);
    await mined(escrow.claimPayout(id));
    await reverts(escrow.claimPayout.staticCall(id), 'PayoutAlreadyClaimed');
    const empty = await create();
    await mined(escrow.cancel(empty.id));
    expect((await escrow.auctions(empty.id)).cancelled).toBe(true);
    await reverts(escrow.cancel.staticCall(empty.id), 'AlreadyCancelled');
    await reverts(escrow.settle.staticCall(empty.id), 'AlreadyCancelled');
    await reverts(escrow.connect(alice).bid.staticCall(empty.id, { value: eth('1') }), 'AlreadyCancelled');
  });

  it.each([0n, 2n ** 255n])('rejects nonexistent auction %s for every id-based action', async (id) => {
    for (const method of ['bid', 'settle', 'cancel', 'claimPayout']) {
      await reverts(escrow[method].staticCall(id), 'AuctionNotFound');
    }
  });
});

describe('exact chain deadlines and creation validation', () => {
  it('accepts bids at bidEnd-1, rejects at bidEnd, and settles exactly at bidEnd', async () => {
    const { id, bidEnd } = await create();
    await nextTime(bidEnd - 1);
    const receipt = await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    expect((await chain.provider.getBlock(receipt.blockNumber)).timestamp).toBe(bidEnd - 1);
    await reverts(escrow.settle.staticCall(id), 'AuctionNotEnded');
    await nextTime(bidEnd);
    const settled = await mined(escrow.connect(guest).settle(id));
    expect((await chain.provider.getBlock(settled.blockNumber)).timestamp).toBe(bidEnd);
    // A separate active auction distinguishes the deadline guard from AlreadySettled.
    const other = await create();
    await mineAt(other.bidEnd);
    await reverts(escrow.connect(alice).bid.staticCall(other.id, { value: eth('1') }), 'AuctionEnded');
  });

  it('rejects payout at parkingEnd-1 and pays exactly at parkingEnd', async () => {
    const { id, bidEnd, parkingEnd } = await create();
    await mined(escrow.connect(alice).bid(id, { value: eth('0.1') }));
    await mineAt(bidEnd);
    await mined(escrow.settle(id));
    await mineAt(parkingEnd - 1);
    await reverts(escrow.claimPayout.staticCall(id), 'ParkingNotEnded');
    await nextTime(parkingEnd);
    const receipt = await mined(escrow.claimPayout(id));
    expect((await chain.provider.getBlock(receipt.blockNumber)).timestamp).toBe(parkingEnd);
    expect((await escrow.auctions(id)).payoutClaimed).toBe(true);
  });

  it('validates hash, minimum and every time-window boundary, allowing parkingStart == bidEnd', async () => {
    const now = await timestamp();
    const args = [hash, 1n, now + 100, now + 200, now + 300];
    await reverts(escrow.createAuction.staticCall(ethers.ZeroHash, ...args.slice(1)), 'InvalidMetadataHash');
    await reverts(escrow.createAuction.staticCall(hash, 0, ...args.slice(2)), 'InvalidMinBid');
    for (const times of [[now - 1, now + 200, now + 300], [now, now + 200, now + 300], [now + 200, now + 100, now + 300], [now + 100, now + 200, now + 200], [now + 100, now + 200, now + 199]]) {
      await reverts(escrow.createAuction.staticCall(hash, 1, ...times), 'InvalidTimeWindow');
    }
    await mined(escrow.createAuction(hash, 1, now + 100, now + 100, now + 101));
    expect(await escrow.nextAuctionId()).toBe(2n);
  });

  it('settles an empty auction but never pays nonexistent proceeds', async () => {
    const { id, bidEnd, parkingEnd } = await create();
    await mineAt(bidEnd);
    await mined(escrow.connect(guest).settle(id));
    expect((await escrow.auctions(id)).settled).toBe(true);
    await mineAt(parkingEnd);
    await reverts(escrow.claimPayout.staticCall(id), 'NoBidsToPayout');
    expect((await escrow.auctions(id)).payoutClaimed).toBe(false);
  });
});

async function recipient() {
  const { abi, bytecode } = recipientArtifact();
  const actor = await new ethers.ContractFactory(abi, bytecode, owner).deploy(await escrow.getAddress());
  await actor.waitForDeployment();
  return actor;
}
const encoded = (method, args = []) => escrow.interface.encodeFunctionData(method, args);

describe('adversarial ETH recipients and reentrancy', () => {
  it.each(['reject', 'withdrawRefund', 'bid', 'settle'])('preserves refunds after recipient failure (%s), then permits a single retry', async (mode) => {
    const actor = await recipient();
    const address = await actor.getAddress();
    const { id } = await create();
    await mined(actor.execute(encoded('bid', [id]), { value: eth('0.1') }));
    await mined(escrow.connect(alice).bid(id, { value: eth('0.2') }));
    const callback = mode === 'reject' ? '0x' : encoded(mode, mode === 'withdrawRefund' ? [] : [id]);
    await mined(actor.configure(mode === 'reject', callback, false));
    const escrowBefore = await balance(await escrow.getAddress());
    await reverts(actor.execute.staticCall(encoded('withdrawRefund')), 'TransferFailed');
    // Send an actual reverting transaction too: all effects, including recipient storage, roll back.
    await expect(mined(actor.execute(encoded('withdrawRefund'), { gasLimit: 1_000_000 }))).rejects.toBeDefined();
    expect(await escrow.pendingReturns(address)).toBe(eth('0.1'));
    expect(await balance(address)).toBe(0n);
    expect(await actor.received()).toBe(0n);
    expect(await balance(await escrow.getAddress())).toBe(escrowBefore);
    // Swallow the inner error to observe its ABI selector without permitting a double payment.
    await mined(actor.configure(false, callback, true));
    await mined(actor.execute(encoded('withdrawRefund')));
    if (mode !== 'reject') expect(await actor.lastError()).toBe(escrow.interface.getError('ReentrantCall').selector);
    expect(await actor.received()).toBe(eth('0.1'));
    expect(await balance(address)).toBe(eth('0.1'));
    expect(await escrow.pendingReturns(address)).toBe(0n);
    expect(await balance(await escrow.getAddress())).toBe(eth('0.2'));
    await reverts(actor.execute.staticCall(encoded('withdrawRefund')), 'ZeroRefund');
    expect((await escrow.auctions(id)).highestBid).toBe(eth('0.2'));
    expect((await escrow.auctions(id)).settled).toBe(false);
  });

  it.each(['reject', 'claimPayout'])('rolls back rejected owner payouts (%s) and permits exactly one retry', async (mode) => {
    const actor = await recipient();
    const address = await actor.getAddress();
    const now = await timestamp();
    await mined(actor.execute(encoded('createAuction', [hash, 1, now + 100, now + 110, now + 120])));
    await mined(escrow.connect(alice).bid(1, { value: eth('0.2') }));
    await mineAt(now + 100);
    await mined(escrow.connect(guest).settle(1));
    await mineAt(now + 120);
    const callback = mode === 'reject' ? '0x' : encoded('claimPayout', [1]);
    await mined(actor.configure(mode === 'reject', callback, false));
    await reverts(actor.execute.staticCall(encoded('claimPayout', [1])), 'TransferFailed');
    await expect(mined(actor.execute(encoded('claimPayout', [1]), { gasLimit: 1_000_000 }))).rejects.toBeDefined();
    expect((await escrow.auctions(1)).payoutClaimed).toBe(false);
    expect(await balance(await escrow.getAddress())).toBe(eth('0.2'));
    expect(await balance(address)).toBe(0n);
    await mined(actor.configure(false, callback, true));
    await mined(actor.execute(encoded('claimPayout', [1])));
    if (mode === 'claimPayout') expect(await actor.lastError()).toBe(escrow.interface.getError('ReentrantCall').selector);
    expect((await escrow.auctions(1)).payoutClaimed).toBe(true);
    expect(await actor.received()).toBe(eth('0.2'));
    expect(await balance(address)).toBe(eth('0.2'));
    expect(await balance(await escrow.getAddress())).toBe(0n);
    await reverts(actor.execute.staticCall(encoded('claimPayout', [1])), 'PayoutAlreadyClaimed');
  });
});

describe('parking-space inventory and overlap protection', () => {
  async function space(signer = owner) {
    const spaceId = await escrow.nextSpaceId();
    await mined(escrow.connect(signer).registerSpace());
    return spaceId;
  }
  async function list(spaceId, parkingStart, parkingEnd, { signer = owner, bidEnd } = {}) {
    bidEnd ??= (await timestamp()) + 100;
    const id = await escrow.nextAuctionId();
    await mined(escrow.connect(signer).createSpaceAuction(spaceId, hash, 1, bidEnd, parkingStart, parkingEnd));
    return id;
  }
  const window = async (from, to) => { const t = await timestamp(); return [t + from, t + to]; };

  it('gives each legacy auction its own stable space and each registered space an owner', async () => {
    const first = await create();
    const second = await create({ signer: alice });
    expect(await escrow.auctionSpace(first.id)).toBe(1n);
    expect(await escrow.auctionSpace(second.id)).toBe(2n);
    expect(await escrow.spaceOwner(2)).toBe(alice.address);
    const spaceId = await space(bob);
    expect(spaceId).toBe(3n);
    expect(await escrow.spaceOwner(spaceId)).toBe(bob.address);
    expect(await escrow.spaceAuctions(spaceId)).toEqual([]);
  });

  it('rejects overlapping windows on one space, allows adjacent windows and other spaces', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    const id = await list(spaceId, start, end);
    for (const [s, e] of [[start, end], [start - 50, start + 1], [end - 1, end + 50], [start + 10, end - 10], [start - 50, end + 50]]) {
      await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, s, e), 'SpaceWindowTaken');
    }
    const before = await list(spaceId, start - 500, start);
    const after = await list(spaceId, end, end + 500);
    const elsewhere = await list(await space(), start, end);
    expect(await escrow.spaceAuctions(spaceId)).toEqual([id, before, after]);
    expect(await escrow.auctionSpace(elsewhere)).not.toBe(spaceId);
  });

  it('lets only the space owner list it, including through direct contract calls', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    await reverts(escrow.connect(alice).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start, end), 'NotSpaceOwner');
    await reverts(escrow.createSpaceAuction.staticCall(999, hash, 1, start - 500, start, end), 'NotSpaceOwner');
  });

  it('releases a window on cancellation or a bidless close, but never under a winning bid', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    const cancelled = await list(spaceId, start, end);
    expect(await escrow.holdsWindow(cancelled)).toBe(true);
    await mined(escrow.cancel(cancelled));
    expect(await escrow.holdsWindow(cancelled)).toBe(false);

    const bidless = await list(spaceId, start, end, { bidEnd: start - 900 });
    await mineAt(start - 900);
    expect(await escrow.holdsWindow(bidless)).toBe(false);

    const won = await list(spaceId, start, end, { bidEnd: start - 500 });
    await mined(escrow.connect(alice).bid(won, { value: 1n }));
    await mineAt(start - 500);
    await mined(escrow.settle(won));
    expect(await escrow.holdsWindow(won)).toBe(true);
    await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, start - 100, start, end), 'SpaceWindowTaken');
  });

  it('accepts only the first of two overlapping listings mined in the same block', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    await chain.provider.send('evm_setAutomine', [false]);
    try {
      const signer = escrow.connect(owner);
      const nonce = await chain.provider.getTransactionCount(owner.address, 'pending');
      const a = await signer.createSpaceAuction(spaceId, hash, 1, start - 500, start, end, { nonce, gasLimit: 500_000 });
      const b = await signer.createSpaceAuction(spaceId, hash, 1, start - 500, start + 10, end + 10, { nonce: nonce + 1, gasLimit: 500_000 });
      await chain.provider.send('evm_mine', []);
      expect((await chain.provider.getTransactionReceipt(a.hash)).status).toBe(1);
      expect((await chain.provider.getTransactionReceipt(b.hash)).status).toBe(0);
    } finally {
      await chain.provider.send('evm_setAutomine', [true]);
    }
    expect((await escrow.spaceAuctions(spaceId)).length).toBe(1);
  });

  const emitted = (receipt, name) => receipt.logs.map((log) => escrow.interface.parseLog(log)).filter((e) => e?.name === name).map((e) => [...e.args]);

  it('lets a delegated lister list windows under the same overlap rule, and only the owner delegates', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    const receipt = await mined(escrow.setSpaceLister(spaceId, alice.address, true));
    expect(emitted(receipt, 'SpaceListerSet')).toEqual([[spaceId, alice.address, true]]);
    expect(await escrow.isSpaceLister(spaceId, alice.address)).toBe(true);
    expect(await escrow.isSpaceLister(spaceId, bob.address)).toBe(false);
    await reverts(escrow.connect(alice).setSpaceLister.staticCall(spaceId, bob.address, true), 'NotSpaceOwner');
    await reverts(escrow.connect(bob).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start, end), 'NotSpaceOwner');

    const byOwner = await list(spaceId, start, end);
    await reverts(escrow.connect(alice).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start + 10, end), 'SpaceWindowTaken');
    const byLister = await list(spaceId, end, end + 500, { signer: alice });
    expect((await escrow.auctions(byLister)).owner).toBe(alice.address);
    expect(await escrow.spaceAuctions(spaceId)).toEqual([byOwner, byLister]);
  });

  it('revoking a host stops new listings, keeps its won reservation, and lets the space owner cancel the rest', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    await mined(escrow.setSpaceLister(spaceId, alice.address, true));
    const open = await list(spaceId, start, end, { signer: alice, bidEnd: start - 500 });
    const won = await list(spaceId, end, end + 500, { signer: alice, bidEnd: start - 500 });
    await mined(escrow.connect(bob).bid(won, { value: 5n }));
    await mined(escrow.setSpaceLister(spaceId, alice.address, false));

    expect(await escrow.isSpaceLister(spaceId, alice.address)).toBe(false);
    await reverts(escrow.connect(alice).createSpaceAuction.staticCall(spaceId, hash, 1, start - 100, end + 500, end + 900), 'NotSpaceOwner');
    await reverts(escrow.connect(guest).cancel.staticCall(open), 'NotAuctionOwner');
    await reverts(escrow.cancel.staticCall(won), 'HasBidsCannotCancel');
    await mined(escrow.cancel(open));
    expect(await escrow.holdsWindow(open)).toBe(false);
    expect(await escrow.holdsWindow(won)).toBe(true);
    await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, start - 100, end, end + 100), 'SpaceWindowTaken');
    await list(spaceId, start, end);

    await mineAt(end + 500);
    await mined(escrow.settle(won));
    await mined(escrow.connect(alice).claimPayout(won));
    expect((await escrow.auctions(won)).payoutClaimed).toBe(true);
  });

  it('transfers a space to a new owner, dropping delegated listers for good', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    await mined(escrow.setSpaceLister(spaceId, alice.address, true));
    const held = await list(spaceId, start, end);
    await reverts(escrow.connect(alice).transferSpace.staticCall(spaceId, bob.address), 'NotSpaceOwner');
    await reverts(escrow.transferSpace.staticCall(spaceId, ethers.ZeroAddress), 'InvalidSpaceOwner');
    const receipt = await mined(escrow.transferSpace(spaceId, bob.address));
    expect(emitted(receipt, 'SpaceTransferred')).toEqual([[spaceId, owner.address, bob.address]]);

    expect(await escrow.spaceOwner(spaceId)).toBe(bob.address);
    for (const signer of [owner, alice]) {
      await reverts(escrow.connect(signer).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, end, end + 100), 'NotSpaceOwner');
    }
    // The previous owner's listing keeps its window and stays theirs.
    expect((await escrow.auctions(held)).owner).toBe(owner.address);
    await reverts(escrow.connect(bob).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start, end), 'SpaceWindowTaken');
    await list(spaceId, end, end + 100, { signer: bob });

    // Transferring back does not revive the old delegation.
    await mined(escrow.connect(bob).transferSpace(spaceId, owner.address));
    expect(await escrow.isSpaceLister(spaceId, alice.address)).toBe(false);
  });

  it('stores an IANA time zone name per space and rejects malformed names', async () => {
    const spaceId = await space();
    expect(await escrow.spaceTimeZone(spaceId)).toBe('');
    const receipt = await mined(escrow.setSpaceTimeZone(spaceId, 'America/Argentina/Buenos_Aires'));
    expect(emitted(receipt, 'SpaceTimeZoneSet')).toEqual([[spaceId, 'America/Argentina/Buenos_Aires']]);
    expect(await escrow.spaceTimeZone(spaceId)).toBe('America/Argentina/Buenos_Aires');
    await mined(escrow.setSpaceTimeZone(spaceId, 'Etc/GMT+5'));
    expect(await escrow.spaceTimeZone(spaceId)).toBe('Etc/GMT+5');
    for (const bad of ['America/New York', '<b>UTC</b>', 'Europe/Zürich', 'A'.repeat(65)]) {
      await reverts(escrow.setSpaceTimeZone.staticCall(spaceId, bad), 'InvalidTimeZone');
    }
    await reverts(escrow.connect(alice).setSpaceTimeZone.staticCall(spaceId, 'UTC'), 'NotSpaceOwner');
    await mined(escrow.setSpaceTimeZone(spaceId, ''));
    expect(await escrow.spaceTimeZone(spaceId)).toBe('');
  });

  it('blocks dates so nothing can be listed over them until they are unblocked', async () => {
    const spaceId = await space();
    const [start, end] = await window(1000, 2000);
    const blockId = await escrow.nextBlockId();
    const receipt = await mined(escrow.blockSpaceWindow(spaceId, start, end));
    expect(emitted(receipt, 'SpaceWindowBlocked')).toEqual([[spaceId, blockId, BigInt(start), BigInt(end)]]);
    expect(await escrow.spaceBlockedWindows(spaceId)).toEqual([blockId]);
    expect([...(await escrow.blockedWindows(blockId))]).toEqual([spaceId, BigInt(start), BigInt(end)]);

    await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start + 10, end + 10), 'SpaceWindowUnavailable');
    await reverts(escrow.blockSpaceWindow.staticCall(spaceId, end - 1, end + 1), 'SpaceWindowUnavailable');
    const adjacent = await list(spaceId, end, end + 500);
    await reverts(escrow.blockSpaceWindow.staticCall(spaceId, end + 100, end + 200), 'SpaceWindowTaken');
    await reverts(escrow.blockSpaceWindow.staticCall(spaceId, end, end), 'InvalidTimeWindow');
    const now = await timestamp();
    await reverts(escrow.blockSpaceWindow.staticCall(spaceId, now - 100, now), 'InvalidTimeWindow');
    await reverts(escrow.connect(alice).blockSpaceWindow.staticCall(spaceId, end + 500, end + 900), 'NotSpaceOwner');

    await reverts(escrow.connect(alice).unblockSpaceWindow.staticCall(blockId), 'NotSpaceOwner');
    await reverts(escrow.unblockSpaceWindow.staticCall(999), 'BlockedWindowNotFound');
    await mined(escrow.unblockSpaceWindow(blockId));
    expect(await escrow.spaceBlockedWindows(spaceId)).toEqual([]);
    const reopened = await list(spaceId, start, end);
    expect(await escrow.spaceAuctions(spaceId)).toEqual([adjacent, reopened]);
  });

  it('bounds the overlap check: caps live windows per space and prunes released or finished ones', async () => {
    const spaceId = await space();
    const max = Number(await escrow.MAX_SPACE_WINDOWS());
    const now = await timestamp();
    const base = now + 10_000;
    await mined(escrow.blockSpaceWindow(spaceId, now + 100, now + 200));
    const gas = [];
    for (let i = 0; i < max - 1; i++) {
      const receipt = await mined(escrow.createSpaceAuction(spaceId, hash, 1, now + 1000, base + i * 100, base + i * 100 + 100));
      gas.push(receipt.gasUsed);
    }
    const next = base + max * 100;
    await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, now + 1000, next, next + 100), 'SpaceCalendarFull');
    await reverts(escrow.blockSpaceWindow.staticCall(spaceId, base - 500, base - 400), 'SpaceCalendarFull');
    const worst = gas.at(-1);
    expect(worst).toBeLessThan(500_000n);

    // One window keeps a winning bid; the others close bidless and the block ends, so they are pruned.
    const won = (await escrow.spaceAuctions(spaceId))[0];
    await mined(escrow.connect(alice).bid(won, { value: 1n }));
    await mineAt(now + 1000);
    const later = await timestamp();
    const pruning = await mined(escrow.createSpaceAuction(spaceId, hash, 1, later + 100, next, next + 100));
    expect(await escrow.spaceBlockedWindows(spaceId)).toEqual([]);
    const after = await mined(escrow.createSpaceAuction(spaceId, hash, 1, later + 100, next + 100, next + 200));
    expect(after.gasUsed).toBeLessThan(gas[0] + 10_000n);
    await reverts(escrow.createSpaceAuction.staticCall(spaceId, hash, 1, later + 100, base, base + 100), 'SpaceWindowTaken');
    await list(spaceId, base + 100, base + 200, { bidEnd: later + 100 });
    console.log(`createSpaceAuction gas: first ${gas[0]}, with ${max - 1} live windows ${worst}, pruning ${pruning.gasUsed}, after pruning ${after.gasUsed}`);
  });

  it('rolls space state back with the chain, so a reorg can hand the same space id to another wallet', async () => {
    const [start, end] = await window(1000, 2000);
    const snapshot = await chain.provider.send('evm_snapshot', []);
    const spaceId = await space();
    await mined(escrow.setSpaceLister(spaceId, alice.address, true));
    await mined(escrow.setSpaceTimeZone(spaceId, 'America/Chicago'));
    await mined(escrow.blockSpaceWindow(spaceId, end, end + 500));
    const id = await list(spaceId, start, end, { signer: alice });
    expect(await escrow.spaceAuctions(spaceId)).toEqual([id]);

    expect(await chain.provider.send('evm_revert', [snapshot])).toBe(true);
    expect(await escrow.nextSpaceId()).toBe(spaceId);
    expect(await escrow.spaceOwner(spaceId)).toBe(ethers.ZeroAddress);
    expect(await escrow.isSpaceLister(spaceId, alice.address)).toBe(false);
    expect(await escrow.spaceTimeZone(spaceId)).toBe('');
    expect(await escrow.spaceBlockedWindows(spaceId)).toEqual([]);
    expect(await escrow.spaceAuctions(spaceId)).toEqual([]);
    expect(await escrow.holdsWindow(id)).toBe(false);

    // On the replacement chain another wallet registers first and gets the same id.
    expect(await space(bob)).toBe(spaceId);
    await reverts(escrow.connect(alice).createSpaceAuction.staticCall(spaceId, hash, 1, start - 500, start, end), 'NotSpaceOwner');
    expect(await list(spaceId, end, end + 500, { signer: bob })).toBe(id);
    expect((await escrow.auctions(id)).owner).toBe(bob.address);
  });
});
