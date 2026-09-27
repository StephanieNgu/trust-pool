import { useCallback, useEffect, useState } from "react";
import {
  connectInjectedWallet,
  getInjectedProvider,
  readWalletSnapshot,
  type WalletSnapshot
} from "./wallet";

interface WalletState extends WalletSnapshot {
  error: string | null;
  isConnecting: boolean;
}

const initialState: WalletState = {
  account: null,
  chainId: null,
  error: null,
  isConnecting: false
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to connect to MetaMask.";
}

export function useWallet() {
  const [state, setState] = useState(initialState);
  const ethereum = getInjectedProvider();

  const applySnapshot = useCallback((snapshot: WalletSnapshot) => {
    setState((current) => ({ ...current, ...snapshot, error: null, isConnecting: false }));
  }, []);

  const connect = useCallback(async () => {
    setState((current) => ({ ...current, error: null, isConnecting: true }));

    try {
      applySnapshot(await connectInjectedWallet());
    } catch (error) {
      setState((current) => ({
        ...current,
        error: messageFromError(error),
        isConnecting: false
      }));
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (!ethereum) {
      return;
    }

    void readWalletSnapshot().then(applySnapshot).catch((error: unknown) => {
      setState((current) => ({ ...current, error: messageFromError(error) }));
    });

    const handleAccountsChanged = (accounts: string[]) => {
      setState((current) => ({ ...current, account: accounts[0] ?? null, error: null }));
    };
    const handleChainChanged = (chainId: string) => {
      setState((current) => ({ ...current, chainId, error: null }));
    };

    ethereum.on?.("accountsChanged", handleAccountsChanged);
    ethereum.on?.("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
      ethereum.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [applySnapshot, ethereum]);

  return {
    ...state,
    connect,
    isMetaMaskAvailable: ethereum !== null
  };
}
