# Class demo seed scenarios

Two fictional versions of the same campus for the class demo. Everything here is illustrative: the spot names, positions, walking times and prices are made up. They are not based on any real campus map, parking rule, permit system or data feed, and none of the spots can be booked.

## Run a scenario

```sh
BIDPARK_SCENARIO=campus-baseline npm run dev
BIDPARK_SCENARIO=campus-expansion npm run dev
```

PowerShell: `$env:BIDPARK_SCENARIO='campus-expansion'; npm run dev`. Leaving it unset keeps the default `austin` listings. An unknown value fails before anything is deployed.

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
