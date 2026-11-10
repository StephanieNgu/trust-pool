import { useEffect, useState } from "react";
import { getProtocolConfig } from "../api";

/** Chain ids of local development chains (Hardhat, Anvil), where the VRF coordinator is Chainlink's mock. */
const LOCAL_CHAIN_IDS = new Set(["31337", "1337"]);

export function isLocalRandomness(chainId: string | null | undefined): boolean {
  return chainId !== null && chainId !== undefined && LOCAL_CHAIN_IDS.has(chainId);
}

/**
 * Labels a jury draw as demo-only on a local chain. There the jury's random word comes from Chainlink's
 * VRF coordinator mock, which anyone can answer, so the draw shows the flow but is not tamper-proof.
 */
export function DemoRandomnessNote() {
  const [chainId, setChainId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getProtocolConfig()
      .then((config) => { if (active) setChainId(config.chainId); })
      .catch(() => { /* Without the config, say nothing rather than guess. */ });
    return () => { active = false; };
  }, []);

  if (!isLocalRandomness(chainId)) return null;
  return <p className="notice demo-randomness" role="note" data-testid="demo-randomness">
    <strong>Demo only:</strong> on this local chain the jury is drawn with Chainlink's VRF test mock, which anyone can answer, so this draw is not tamper-proof. On a public network such as Sepolia the random word comes from Chainlink with a proof checked on-chain.
  </p>;
}
