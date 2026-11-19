# Class demo seed scenarios

Two fictional versions of the same campus for the class demo. The presenter run order and fallback screenshots are in [class demo presenter script](class-demo-presenter.md). Everything here is illustrative: the spot names, positions, walking times and prices are made up. They are not based on any real campus map, parking rule, permit system or data feed, and none of the spots can be booked.

## Run a scenario

```sh
BIDPARK_SCENARIO=campus-baseline npm run dev
BIDPARK_SCENARIO=campus-expansion npm run dev
```

PowerShell: `$env:BIDPARK_SCENARIO='campus-expansion'; npm run dev`. Leaving it unset keeps the default `austin` listings. An unknown value fails before anything is deployed.

In a campus scenario the marketplace opens with a banner: it calls the app an unofficial campus-parking parody, names the scenario, counts the near-campus spots actually listed, and says all prices, bids and wins are simulated. Each card shows its walking-distance tier as text. If map tiles do not load, choose **Cards** for a plain list; it works by keyboard at phone widths.

Each scenario gets its own contract deployment. Switching scenarios on a running chain redeploys and clears the previous scenario's listings, so the two never mix. Re-running the same scenario reuses its deployment. The fixtures live in `scripts/helpers/seed-data.mjs`.

## Shared rules (identical in both)

| | Near campus | Farther away |
| --- | --- | --- |
| Listing neighborhood | `Near campus · 3-5 min walk` | `Farther away · 15-20 min walk` |
| Opening bid | 0.03 ETH | 0.01 ETH |

Every spot uses the same window: bidding closes 60 minutes after seeding, parking runs from 90 to 330 minutes after seeding. No seed bids are placed; scripted bids belong to the walkthrough (#38).

## Fixtures

| ID | Spot | Tier | Walk | Baseline | Expansion |
| --- | --- | --- | --- | --- | --- |
| N1 | Quad Edge Commuter Spot | near | 3 min | yes | yes |
| N2 | Library Row Commuter Spot | near | 4 min | yes | removed |
| N3 | Old Gym Lot Commuter Spot | near | 4 min | yes | removed |
| N4 | Science Hall Deck Commuter Spot | near | 5 min | yes | removed |
| F1 | Riverside Overflow Lot Spot | far | 15 min | yes | yes |
| F2 | Stadium Remote Lot Spot | far | 18 min | yes | yes |
| F3 | Park-and-Walk Garage Spot | far | 20 min | yes | yes |

Listing titles start with the ID, e.g. `N1 · Quad Edge Commuter Spot [Fictional Class Demo]`.

## Expected counts

| Scenario | Total | Near | Far |
| --- | --- | --- | --- |
| `campus-baseline` | 7 | 4 | 3 |
| `campus-expansion` | 4 | 1 | 3 |

## Intentional differences

The only planned change is that the fictional residence-hall expansion takes over N2, N3 and N4 (`CAMPUS_EXPANSION_REMOVED`). N1 and F1-F3 are byte-identical in both scenarios, so they have the same metadata hash. Tiers, opening bids, timing and the far-away fallback do not change.

`tests/api/campus-scenarios.test.mjs` checks these counts against both seeds through the API.

## Scenario comparison

```sh
npm run demo -- compare
```

prints the near/far counts straight from the fixtures, with no chain needed:

| | Baseline | Expansion |
| --- | --- | --- |
| Near campus spots (fixture count) | 4 | 1 |
| Farther-away spots (fixture count) | 3 | 3 |
| Opening bid, near / far | 0.03 / 0.01 ETH | 0.03 / 0.01 ETH |

The only planned change is the residence hall taking N2, N3 and N4.

### Scripted commuter example

With a campus scenario running, play out the same four example commuters (Accounts #1 to #4) and then refresh the app:

```sh
npm run demo -- commuters
```

The script follows one fixed rule, in commuter order. Take a free near spot at its opening bid. If none is free, outbid whoever leads N1 by 0.01 ETH. Anyone outbid then takes the next farther-away spot at its opening bid. Bidding closes, every auction with a bid is settled, and the winners are read back from the chain.

| Commuter | Baseline result | Expansion result |
| --- | --- | --- |
| Commuter 1 | N1, near, 0.03 | F1, far, 0.01 |
| Commuter 2 | N2, near, 0.03 | F2, far, 0.01 |
| Commuter 3 | N3, near, 0.03 | F3, far, 0.01 |
| Commuter 4 | N4, near, 0.03 | N1, near, 0.06 |

The spot counts come from the fixtures. The bid amounts come from the script's 0.01 ETH raise, which is one illustrative choice. They are not a prediction and do not show that scarcity sets any particular price. Different bidders or rules would give different amounts. Restart `npm run dev` before running it again. `tests/api/scenario-comparison.test.mjs` checks this table against both seeds.

## Auction walkthrough

Simulated roles, all built-in local test wallets (no wallet extension or public network):

| Role | Wallet menu entry |
| --- | --- |
| Host (owns every seeded spot) | Account #0 |
| Driver A | Account #1 |
| Driver B | Account #2 |

The bid amounts below are scripted for the demo. They are not derived from the fixtures and say nothing about what scarcity would do to a real price.

### Live, in the app

1. Start a scenario (see above) and open http://127.0.0.1:5173.
2. **Connect Wallet**, pick Account #1. Open **N1 · Quad Edge Commuter Spot**, **Bid Now**, bid `0.03`.
3. Switch to Account #2 and bid `0.05` on N1.
4. Switch back to Account #1, open **My Activity**: N1 shows "Outbid — bidding still open" and **Withdraw 0.030 ETH**. Withdraw it.
5. In a second terminal, close bidding without waiting an hour:
   ```sh
   npm run demo -- advance
   ```
   Then press **Refresh data** in the app.
6. Switch to Account #2. **My Activity** shows "You won — pending settlement". Press **Settle Auction & Claim Pass**; it changes to "You won — confirmed on-chain".

### Scripted fallback

If clicking through is not an option, run the same sequence in one step while `npm run dev` is running, then refresh the app:

```sh
npm run demo -- walkthrough
```

It prints each step and ends with driver B winning N1 at 0.05 ETH, driver A's 0.03 ETH withdrawn, and the auction settled. It refuses to run if N1 already has bids.

### Reset

Stop `npm run dev` with Ctrl+C and start it again with the same `BIDPARK_SCENARIO`. The local chain is in memory, so a restart redeploys and reseeds from scratch, and the walkthrough produces the same result every time. The demo helpers only talk to a loopback RPC on chain 31337 with the local profile, and only to the deployment in this checkout's `data/` directory (or `BIDPARK_DATA_DIR`). They never touch another running stack or a public network.

`tests/api/demo-walkthrough.test.mjs` runs the walkthrough on two fresh stacks and checks that both give the same result.
