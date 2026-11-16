# Jury randomness with Chainlink VRF

Milestone 3 feedback: the backend keeper owned the mock randomness seed and so could bias jury
selection. Trust Pool now draws every jury from **Chainlink VRF v2.5**. This page explains what that
guarantees, how it runs locally and on Sepolia, and how it is tested.

## How a jury is drawn

```mermaid
sequenceDiagram
    participant C as Claimant
    participant CM as ClaimManager
    participant JM as JuryModule
    participant R as VRFRandomness
    participant V as Chainlink VRF coordinator
    C->>CM: submitClaim
    CM->>JM: requestJury (needs at least 5 eligible jurors)
    JM->>R: requestRandomness(claimId)
    R->>V: requestRandomWords(keyHash, subId, 1 word)
    Note over V: Chainlink oracle produces the word and its VRF proof
    V->>R: rawFulfillRandomWords(requestId, [word])  (proof checked on-chain)
    R->>JM: fulfillRandomness(claimId, word)  (same transaction; stores the seed only)
    participant K as Anyone (keeper, demo script, member)
    K->>JM: seatJury(claimId)
    JM->>JM: pick 5 members who were eligible at filing, in an order fixed by the seed
    JM->>CM: startVoting
```

### Why two steps

Chainlink makes the subscription hold back LINK in proportion to the callback's gas limit for every
pending request: about 133 LINK at the 1,000,000 gas a full jury draw needed, more than a faucet
gives. So the callback now only stores the seed (about 35k gas, with a 150,000 gas limit, so roughly
24 LINK held back), and `seatJury` picks the jury in an ordinary transaction that anyone can send.
Locally the keeper sends it straight after the mock answers; on Sepolia the demo script does.

**No new storage in the callback.** Sepolia runs EIP-8037 (Glamsterdam), which charges about 98k gas
for every storage slot a transaction creates. Our first 100k-gas deployment stored the seed in a fresh
slot and ran out of gas on Sepolia while passing locally (Hardhat uses the older gas schedule). Now
`requestJury` writes a placeholder when the claim is filed, so the callback only overwrites slots, and
`test/unit/JurySeating.test.js` traces the callback to check that it creates none.

Because the seed is public for a moment before the jury is seated, `seatJury` only picks from members
who were **already eligible when the claim was filed** (policy past its waiting period and stake
placed by then, via `Pool.stakedAt`) and are still eligible now, and it takes them in an order fixed
by the seed (up to 25 holders: lowest `keccak256(seed, member)`; above that: index draws
`keccak256(seed, n) % holdersAtFiling`). So the only thing anyone can do with an early look at the
seed is **drop out**, which removes themselves: the next member in that order takes the seat and
nobody else moves. Nobody can join a draw, reorder it, or re-roll it (once the seed is in, the claim
can no longer be cancelled for a timeout).

## What stops anyone from choosing the jury

| Who | Could they pick the seed? | Why not |
|---|---|---|
| Backend keeper / deployer | No | `VRFRandomness` has no owner and no admin function. The old `MockRandomness.fulfill(claimId, seed)` is gone. `JuryModule.fulfillRandomness` only accepts calls from `VRFRandomness`. |
| Deployer swapping the coordinator | No | The coordinator, subscription and key hash are immutable. (Chainlink's own `VRFConsumerBaseV2Plus` lets its owner call `setCoordinator`, which is why we do not inherit it.) |
| Swapping the randomness provider | No | `JuryModule.randomness` is immutable. |
| Re-rolling a bad draw | No | Each request is answered once, and `JuryModule` keeps only the first seed. A claim with a seed cannot be cancelled for a timeout, so nobody can throw a draw away. |
| Whoever calls `seatJury` | No | The jury depends only on the stored seed and on who is eligible; the caller and the timing do not enter into it. |
| Members gaming eligibility after seeing the seed | Only by leaving | Only members eligible at filing are candidates, so staking or buying a policy after the seed does not get anyone in. A member can unstake or lapse to drop themselves out; the next in the seed's order replaces them. Paying a picked juror to leave so a friend moves up is the remaining (costly, visible) attack; the keeper seats juries within seconds of the seed to keep that window short. |
| Chainlink's oracle | No | The word comes with a VRF proof that the coordinator verifies on-chain against the registered key. |

The one remaining trust assumption is **liveness**: the VRF subscription owner could stop funding
it. A claim whose randomness never arrives can be cancelled by anyone after one day, with the
claimant's bond returned in full.

Every delivered word is stored in `JuryModule.seedOf(claimId)` and emitted in `RandomnessFulfilled`,
`SeedReceived` and `JurySelected`, so anyone can recompute the draw.

## Too few jurors

A jury is always `jurySize` members: five by default, three on the Sepolia deployment (`TESTNET_PARAMS`). Two cases are covered:

1. **At filing:** `submitClaim` reverts with `NotEnoughEligibleJurors(available, jurySize)` if fewer than
   `jurySize` other members are covered, past their waiting period and staked.
2. **Before the jury is seated:** if members cancel or unstake before `seatJury` and fewer than
   `jurySize` candidates remain, no short jury is seated. The claim is marked `starved`, `JuryStarved` is
   emitted, and the claim can be cancelled immediately (no one-day wait), returning the bond.
   Previously the contract quietly seated a smaller jury, possibly of zero.

## Local chain (default)

Nothing to set up. `scripts/deploy.js` (and every test) deploys Chainlink's official
`VRFCoordinatorV2_5Mock`, creates and funds a subscription, and registers `VRFRandomness` as a
consumer. The backend keeper calls the mock's `fulfillRandomWords(requestId, consumer)`, where the
mock derives the word from the request id (the keeper passes no seed), then calls `seatJury`.

**Local-only caveat.** There is no Chainlink oracle on a local chain, so the mock lets anyone answer
a request, and its `fulfillRandomWordsWithOverride` lets the caller pick the word (the tests use this
to make draws reproducible). Local runs show the flow; Sepolia shows unbiasable randomness.

## Sepolia (real Chainlink VRF)

You need, once:

1. **An RPC URL** for Sepolia, free from Alchemy or Infura.
2. **A throwaway deployer wallet** with Sepolia ETH from a faucet (about 0.1 ETH covers deployment
   and the demo). Never use a wallet that holds real funds.
3. **A VRF subscription** at [vrf.chain.link](https://vrf.chain.link) on Ethereum Sepolia, created
   from the same wallet as the deployer (so the deploy script can add the consumer for you), and
   funded with test LINK from [faucets.chain.link](https://faucets.chain.link) or with Sepolia ETH.

Then:

```bash
cp .env.example .env
# fill in SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, VRF_SUBSCRIPTION_ID
# set VRF_NATIVE_PAYMENT=true if you funded the subscription with Sepolia ETH instead of LINK

npx hardhat run scripts/deploy.js --network sepolia
npx hardhat run scripts/sepolia-vrf-demo.js --network sepolia
```

`deploy.js` checks that the key hash is registered on the coordinator and that the subscription
exists before deploying, then adds `VRFRandomness` as a consumer if the deployer owns the
subscription (otherwise it prints what to add on vrf.chain.link). Addresses go to
`deployments/sepolia.json`.

Before sending anything, `deploy.js` prints the wallet's balance and the expected cost at the current
gas price (the full deploy is about 10M gas), and stops if the wallet holds less than 1.5 times that.
A deploy that still stops partway (the wallet ran dry, the terminal closed) is not wasted: run the
same command again and it finds the contracts this wallet already deployed, reuses them, and only
deploys and links what is missing. It recognises them by how they point at each other and only
reuses a set made for the same VRF subscription and testnet settings. Set `FRESH_DEPLOY=true` to
ignore an unfinished deployment and start over.

`sepolia-vrf-demo.js` makes six throwaway member wallets (keys saved, git-ignored, in
`deployments/sepolia-demo-wallets.json`), funds each with a little Sepolia ETH for gas, has them buy
policies and stake, files a claim, and waits for Chainlink to answer (usually one to three minutes).
It prints the seed, the coordinator's fulfilment transaction on Etherscan, then calls `seatJury` and
prints the jurors (three on Sepolia, see TESTNET_PARAMS). If Chainlink takes longer than the wait,
`CLAIM_ID=<n> npx hardhat run scripts/sepolia-vrf-demo.js --network sepolia` picks that claim up later.

**Funding the subscription.** Use **Add funds** on vrf.chain.link (it calls the LINK token's
`transferAndCall`). A plain LINK transfer to the coordinator address is not credited to any
subscription and cannot be recovered.

Defaults (override in `.env`): coordinator `0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B`, key hash
`0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae`, 3 confirmations, 150,000
callback gas. Check the current values on Chainlink's
[supported networks](https://docs.chain.link/vrf/v2-5/supported-networks) page if a deploy fails the
key hash check.

The web app and backend still run against the local chain: they rely on unlocked dev accounts and
on fast-forwarding time past voting deadlines, which a public testnet cannot do.

## Tests

* `test/unit/VRFRandomness.test.js`: requests and fulfilment through the coordinator, configuration
  checks, and the manipulation cases from the feedback: the deployer (keeper) key and members cannot
  push a seed or bypass the provider, there is no owner or `setCoordinator`, the consumer link is
  one-time, a request cannot be answered twice, and 40 draws spread across all eligible members.
* `test/unit/JurySeating.test.js`: the two-step draw. The callback only stores the seed and fits in
  150,000 gas and creates no new storage slot; anyone can seat and gets the jury anyone can compute from the seed; a member who drops
  out after seeing the seed removes only themselves; late stakers, re-bought policies and new members
  cannot join; a seeded claim cannot be cancelled; too few candidates starves instead of seating short.
* `test/unit/JuryModule.test.js` (jury starvation): filing with four eligible jurors reverts; jurors
  lapsing or unstaking before the seed arrives starves the claim instead of seating four, and the
  claim can be cancelled at once.
* `test/unit/ClaimManager.test.js`: a VRF answer arriving after a timed-out claim was cancelled
  cannot seat a jury.
* `backend/test`: the keeper drives the local coordinator mock, and turns itself off where
  Chainlink delivers.
