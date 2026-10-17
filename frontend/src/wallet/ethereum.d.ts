import type { Eip1193Provider } from "ethers";

export interface InjectedEthereumProvider extends Eip1193Provider {
  isMetaMask?: boolean;
  isTrustPoolDemo?: boolean;
  demoAccounts?: readonly { id: string; label: string; address: string }[];
  selectDemoAccount?(address: string): void;
  on?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on?(event: "chainChanged", listener: (chainId: string) => void): void;
  removeListener?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  removeListener?(event: "chainChanged", listener: (chainId: string) => void): void;
}

declare global {
  interface Window {
    ethereum?: InjectedEthereumProvider;
  }
}

export {};
