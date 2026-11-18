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
