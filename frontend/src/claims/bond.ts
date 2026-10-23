/**
 * The claimant's bond, mirroring ClaimManager: `bondBps` of the amount asked, but at least `minBond`.
 */
export function claimBond(amount: bigint, bondBps: number, minBond: bigint): bigint {
  const bond = (amount * BigInt(bondBps)) / 10_000n;
  return bond < minBond ? minBond : bond;
}

