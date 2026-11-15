import { useState } from "react";
import { claimTestTokens } from "../contracts/member";
import { contractErrorMessage } from "../contracts/errors";

interface TestnetFaucetProps {
  account: string;
  ready: boolean;
  networkLabel: string;
  tokenSymbol: string;
  onFunded(): void;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) {
    return "Request cancelled in your wallet.";
  }
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "The faucet could not send test tokens.";
}

/** On a public testnet, lets a new member get test mUSDC, and points them to a Sepolia ETH faucet for gas. */
export function TestnetFaucet({ account, ready, networkLabel, tokenSymbol, onFunded }: TestnetFaucetProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function claim() {
    setBusy(true); setError(""); setStatus("");
    try {
      await claimTestTokens(account, setStatus);
      setStatus(`1,000 test ${tokenSymbol} added to your wallet.`);
      onFunded();
    } catch (caught) {
      setStatus("");
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return <div className="notice testnet-faucet" role="note" data-testid="testnet-faucet">
    <div>
      <strong>{networkLabel} testnet:</strong> everything here uses test money.{" "}
      You need a little {networkLabel} ETH for gas (free from the{" "}
      <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noreferrer">Google Cloud faucet</a>{" "}
      or the <a href="https://faucets.chain.link/sepolia" target="_blank" rel="noreferrer">Chainlink faucet</a>) and test {tokenSymbol} to join the pool.
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
    <button className="text-button" type="button" disabled={!ready || busy} onClick={() => void claim()}>
      {busy ? "Sending…" : `Get 1,000 test ${tokenSymbol}`}
    </button>
  </div>;
}
