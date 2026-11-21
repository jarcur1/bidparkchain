# Class demo rehearsal

Record of a full rehearsal from a fresh checkout of `coding/mvp` at `389c914` on Windows 11. It used the real `npm run dev` launcher, the built-in demo accounts, and no wallet extension, credentials or public network. Use it with the [presenter script](class-demo-presenter.md) and [scenario guide](class-demo-scenarios.md).

## Exact commands

```sh
git clone https://github.com/jarcur1/bidparkchain.git
cd bidparkchain
npm ci                                            # 22 s; needs npm 11 (Node 24), see limitations
BIDPARK_SCENARIO=campus-baseline npm run dev      # ready in a few seconds
npm run demo -- compare                           # second terminal
# Ctrl+C, then:
BIDPARK_SCENARIO=campus-expansion npm run dev
npm run demo -- walkthrough                       # second terminal; or click through the presenter script
```

PowerShell: `$env:BIDPARK_SCENARIO='campus-expansion'; npm run dev`.

## What was verified

| Check | Result |
| --- | --- |
| Baseline through the real launcher (`/api/listings` via port 5173) | 7 listings: 4 near, 3 far; `/api/config` reports `campus-baseline` |
| `npm run demo -- compare` | Same counts read from the fixtures; only N2-N4 differ |
| Switch to the expansion on the same checkout | Launcher logs "Seed scenario changed ... Re-deploying" and clears the 7 old listings; 4 listings: 1 near, 3 far |
| Bid, competing bid, withdraw, advance clock, settle (`npm run demo -- walkthrough`) | Driver B (account 2) wins N1 at 0.05; driver A's 0.03 withdrawn; N1 settled |
| Rerun without a reset | Refused: "Spot N1 already has bids. Restart npm run dev for a clean run." |
| Reset (stop and restart `npm run dev`) and rerun | Fresh deployment, N1 back to no bids; the walkthrough gives the identical result |
| Targeted browser check: `npx playwright test campus presenter` | 5/5 pass in 35 s |

The browser check covers what can't be read from the API. It runs at the 1280x720 projector size and at 375 px, with every off-origin request (map tiles, photos, fonts) blocked. In that setup it:
- switches demo accounts and places two competing bids
- withdraws the displaced amount, settles, and shows the mock win
- uses the Cards list by keyboard
- checks the "simulated test ETH" banner and the "no real parking" wording on the pass

On a machine with Google Chrome and no Playwright browser, prefix it with `BIDPARK_E2E_CHANNEL=chrome`.

## Classroom setup

- One laptop with Node.js 24 and the repo installed beforehand. Nothing else needs the network once `npm ci` is done.
- Two terminals: one for `npm run dev`, one for `npm run demo -- ...`.
- Ports 5173, 3001 and 8545 free. The launcher refuses to start if one is taken, and names the port.
- Project the browser at about 1280x720. Use **Cards** so nothing depends on the map.

## Known limitations

- **npm version.** `npm ci` fails with npm 10, which ships with Node 22, because the lockfile needs npm 11. Use Node 24 as the README says, or run `npx npm@11 ci` once. The app itself also ran fine on Node 22.17 after installing.
- **Offline look.** Map tiles and listing photos come from the internet. Without it the map is blank and cards show alt text instead of photos. The Cards list, the bids and every status still work.
- **Switching scenarios needs a restart.** Each scenario is its own local deployment, and restarting is also the reset. The walkthrough and commuters helpers only run on a freshly started scenario.
- **The clock advance moves the whole chain.** `npm run demo -- advance` closes bidding on every open auction at once, which is what the script wants. The in-app **Skip to bidding close** button does the same on local runs, and **Skip to parking end** does the same for parking.
- **Stopping.** Stop the launcher with Ctrl+C in its terminal. If the terminal is killed some other way, the chain, API and web server can keep running and hold their ports, and the next `npm run dev` will say a port is in use. End the leftover `node` processes first.
- **Notifications stack up.** Each action adds a toast in the corner. They clear one at a time, about every 6 seconds, or close them with their X.

## Fallback rehearsed

`npm run demo -- walkthrough` was run against the live launcher as the "clicks went wrong" fallback, and the screenshots in [`presenter/`](presenter/) cover a total failure. Both match the live result: driver B wins N1 at 0.05 ETH.
