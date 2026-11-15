import { useEffect, useState } from "react";
import { chainIdHex, isLocalChain, loadDeployment, networkLabel } from "./contracts/deployments";

export interface TargetNetwork {
  /** Decimal chain id of the deployment the backend serves, e.g. "31337" or "11155111". */
  chainId: string;
  /** The same id as MetaMask reports it, e.g. "0x7a69". */
  chainIdHex: string;
  label: string;
  local: boolean;
}

/**
 * The chain the app's contracts live on, as the backend reports it. Null until it loads (or if the
 * backend is down), in which case the app treats the wallet as not yet on the right network.
 */
export function useTargetNetwork(retry: number): TargetNetwork | null {
  const [target, setTarget] = useState<TargetNetwork | null>(null);
  useEffect(() => {
    let active = true;
    loadDeployment()
      .then(({ chainId }) => {
        if (active) setTarget({ chainId, chainIdHex: chainIdHex(chainId), label: networkLabel(chainId), local: isLocalChain(chainId) });
      })
      .catch(() => { /* The dashboard load reports a backend problem; keep the last known target. */ });
    return () => { active = false; };
  }, [retry]);
  return target;
}
