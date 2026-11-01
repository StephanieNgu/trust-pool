# Oracle Scope and Anti-Fraud Limitations

This records two decisions the Milestone 3 feedback asked us to make explicit:

1. What happened to the original proposal's basic oracle feed, now that every claim is decided by a
   member jury.
2. What the anti-fraud measures actually do, what they do not do, and which claims about fraud and
   fairness we can and cannot support with evidence.

The short version: **the claim oracle is deferred, not built.** Claims are decided by a vote of
randomly drawn members. **A jury approval is a group judgment, not proof that a claim is
legitimate,** and nothing in this repository measures how well the design resists collusion.

## 1. The oracle decision

### What was proposed

The original proposal paired the pool with a basic oracle feed: an external data source that would
report on a claim (for example, that a device was reported damaged, stolen or repaired) so the
contracts could act on it without relying only on people's judgment.

### What we built instead

Every claim is decided by a jury of five randomly drawn, staked members who vote a payout amount
(see [design-doc.md](design-doc.md), Sections 5 and 7). No external data source tells the contracts
anything about a claim. The only oracle in the system is **Chainlink VRF, and it supplies jury
randomness, not facts about claims** ([vrf.md](vrf.md)). It decides *who* judges a claim; it says
nothing about *whether* the claim is true.

### Decision: defer the claim oracle

| Option | What it would mean | Why not now |
|---|---|---|
| Oracle only (parametric payout) | A feed reports an event and the contract pays automatically | There is no public, tamper-resistant feed that says "this phone's screen cracked". Device damage is a private event, unlike weather or flight delays, which is where parametric insurance works |
| Hybrid: oracle for facts, jury for judgment | Feeds answer narrow factual questions (is this IMEI blacklisted, did a registered shop sign this invoice, what does this model cost) and jurors decide the rest | Each feed needs a data provider, an agreement with it and an on-chain adapter. None is available to a course project on a testnet, and a mocked feed would add a component that looks like verification but verifies nothing |
| **Member jury only (chosen)** | Members judge evidence and vote an amount; the contracts enforce the process and the money | Works with what we can build and test. Its limits are stated in Section 2 instead of being hidden behind a mocked feed |

This is a scope decision, not a claim that juries are better than oracles. A jury trades the
oracle's dependence on an external data provider for a dependence on the honesty and attention of
a few members.

### What an oracle could add later

These are the places where external data would replace a juror's guess with a checkable fact, in
the order we would try them:

1. **Signed repair invoices.** Registered repair shops sign the invoice with a key the pool knows.
   This would turn the receipt step from "a file the backend has not seen before" into "a shop we
   know says it did this repair".
2. **Stolen or blacklisted device lookups** (carrier or GSMA IMEI data) at signup and at claim time.
3. **Replacement price feed** for each device model, to cap an offer at the market price.
4. **Platform device attestation** (Apple App Attest, Google Play Integrity) to show a claim came
   from a genuine, specific device. This needs a native app.

We would revisit the decision if a provider for item 1 or 2 became available, or if claim volume
made juries too slow or too expensive. Each of these would narrow what jurors have to judge; none
of them would remove the need for judgment on whether the damage happened as described.

## 2. Anti-fraud: what each measure does and does not show

The table below is the honest reading of each measure. "Does not show" is the part that matters for
how we describe the system.

| Measure | What it does | What it does not show |
|---|---|---|
| Jury approval (quorum of 3, median amount) | Records that at least three revealed jurors voted and that the middle vote was above 0 | That the device was damaged, that the photos are genuine, or that the amount is right. It shows only what most of the jurors who voted chose |
| Evidence hash on-chain | Shows the files a juror opens are byte-for-byte the files the claimant filed ("unchanged since filing") | Anything about what the files depict. A staged or borrowed-phone photo hashes just as cleanly. The contract accepts any non-zero hash, including one used before (see the limitation tests) |
| Random jury (Chainlink VRF) | Stops the backend, deployer or claimant from choosing jurors. On Sepolia the draw is checked on-chain; locally the coordinator mock lets anyone answer, so local runs show the flow, not unbiasability | That the people drawn are independent or honest. One person with several staked wallets is drawn as several jurors |
| Commit-reveal voting | Jurors cannot see or copy each other's votes before committing | Coordination arranged outside the app. Votes become public at reveal, so a briber can check afterwards how a juror voted |
| Juror fee for agreeing, no-show penalty | Gives jurors a reason to vote and to reveal | That agreeing jurors were right. The fee rewards matching the outcome, so a colluding majority is paid and an honest minority is not |
| Claimant bond (5%, lost in proportion to the cut) | Makes a claim the jury rejects or cuts cost the claimant something | Any cost for a fraudulent claim the jury approves in full. The bond only bites when jurors catch the problem |
| Capture code in photos | Shows the photos were taken after the code was issued | That the device is the claimant's or that the damage is real |
| Signup photos, IMEI/serial match, optional device key, proof of purchase | Give jurors more to compare, and the device key ties a claim to the browser that enrolled | Ownership. These are signals for jurors, not checks the contracts enforce |
| Receipt-gated payout, one-use receipt files | Ties the payout amount to a receipt and refuses a receipt file the backend has seen before | That the receipt is real or that the shop exists. Nobody checks the receipt with the shop; jurors are not asked to review it |
| Waiting period, one policy per wallet and per device | Blocks "buy cover, then claim at once" and insuring the same device ID twice | Sybil attacks: a new wallet with a new (or invented) device ID is a new member |

### Wording we use, and wording we avoid

| Avoid | Use instead |
|---|---|
| "verifies the claim", "fraud verification", "proves the claim is legitimate" | "the jury decides the claim", "jurors review the evidence" |
| "Hash verified" (on its own) | "unchanged since filing", "the file matches the on-chain fingerprint" |
| "prevents fraud", "fraud-proof", "collusion-resistant" | "raises the cost of", "makes harder", "deters" (and say against whom) |
| "fair outcome" | "the median of the revealed votes" |
| "random selection prevents collusion" | "random selection means the claimant cannot choose jurors" |

The frontend follows this: the evidence badge reads "Unchanged since filing", and jurors are told
that the fingerprint shows only that the files were not altered, not that the claim is genuine.

## 3. Collusion: what is tested and what is not

### What is tested

The test suite checks that the **mechanisms run as specified**: a claimant is never on their own
jury, commitments are bound to their juror, a reveal must match its commit, the median ignores one
extreme vote, fees and penalties are computed as documented, and the deployer and keeper cannot
choose a VRF seed. These are correctness tests. They say the rules are enforced, not that the rules
stop fraud.

`test/unit/limitations.test.js` writes the main limitations down as passing tests, so they stay
visible and cannot quietly change:

- Three colluding jurors out of five get a fabricated claim **paid in full**, with any receipt hash.
  They also earn the agreement fee, the two honest jurors earn nothing, and the claimant keeps the
  whole bond.
- Two colluders lose to three honest jurors, but only because the honest jurors are the majority.
- Two colluders are enough when two honest jurors do not reveal: quorum is met with three revealed
  votes, and the median is the colluders' amount.
- The contract accepts an evidence hash that another claim already used. Refusing reused photos is
  a backend check.

### What is not tested

There are **no objective tests of collusion or bribery resistance**: no simulation of attackers,
no game-theoretic analysis of the fee and bond values, and no data from real jurors. The fee (2%),
bond (5%), agreement band (10%) and penalty (5 mUSDC) are demo values. Statements elsewhere that a
measure "deters" or "raises the cost of" fraud describe the design's intent, not a measured effect.

### A rough estimate (analytic, not measured)

If a jury of 5 is drawn uniformly from *N* eligible members, of whom *K* are colluders (or one
person's wallets), the chance that colluders hold at least 3 seats is hypergeometric:

| Eligible members *N* | Colluders *K* | P(at least 3 of 5 jurors collude) |
|---|---|---|
| 10 | 3 | 8.3% |
| 20 | 4 (20%) | 3.2% |
| 20 | 6 (30%) | 13.1% |
| 50 | 10 (20%) | 4.8% |
| 100 | 20 (20%) | 5.3% |
| 100 | 30 (30%) | 15.8% |

This understates the risk in three ways the model leaves out:

- **Honest no-shows.** Only revealed votes count and quorum is 3. If two honest jurors do not
  reveal, two colluders and one honest juror decide the claim, and the median is the colluders'.
- **Repeat attempts.** A claim the jury rejects costs the bond, and the claimant can file again.
- **Bribery after selection.** Jurors are public once drawn, and reveals let a briber check votes.

It also leaves out what the attack costs: each colluding wallet pays premiums, locks a 20 mUSDC
stake and waits out the waiting period. Whether that cost outweighs the expected payout depends on
pool size and claim size, and we have not modelled it.

### What objective testing would look like

1. An agent-based simulation over the real contract parameters: pool size, colluding share, honest
   no-show rate, claim sizes and repeat attempts, reporting the attacker's expected profit.
2. Property tests (fuzzing) that draw many juries from a pool with a known colluding share and
   compare the observed capture rate with the formula above.
3. A cost model for a Sybil attacker (premiums, stakes, waiting period) against the 20% payout cap.

Until these exist, the project claims only that the contracts enforce the jury process as
specified, and that the anti-fraud measures add cost or friction for a dishonest claimant in the
specific ways the table in Section 2 lists.
