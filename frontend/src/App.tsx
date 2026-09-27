import { useEffect, useRef, useState, type FormEvent } from "react";
import { HARDHAT_LOCAL_CHAIN_ID, useWallet } from "./wallet";
import { purchaseCoverage, quoteCoverage, readOverview, type Overview } from "./contracts/insurance";

type IconName = "grid" | "shield" | "wallet" | "pool" | "arrow" | "check";
function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const paths = { grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z", shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6", wallet: "M4 6V4h14v3 M3 7h18v14H3z M16 12h5v5h-5z", pool: "M3 7l9-4 9 4-9 4z M3 12l9 4 9-4 M3 17l9 4 9-4", arrow: "M4 12h16 M14 6l6 6-6 6", check: "M5 12l4 4L19 6" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const money = (value?: string) => value === undefined ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) return "Request cancelled in your wallet. You can try again.";
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function App() {
  const wallet = useWallet();
  const [page, setPage] = useState<"dashboard" | "coverage">("dashboard");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [device, setDevice] = useState("");
  const [amount, setAmount] = useState("");
  const [premium, setPremium] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [formError, setFormError] = useState("");
  const [activities, setActivities] = useState<{ hash: string; account: string; amount: string; time: string }[]>([]);
  const identity = `${wallet.account}:${wallet.chainId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const correctNetwork = wallet.chainId === HARDHAT_LOCAL_CHAIN_ID;
  const ready = Boolean(wallet.account && correctNetwork && overview);

  useEffect(() => {
    let active = true;
    setOverview(null); setLoadError(""); setPremium(null); setFeedback(""); setFormError("");
    if (!wallet.account || !correctNetwork) { setLoading(false); return; }
    setLoading(true);
    void readOverview(wallet.account).then(data => { if (active) setOverview(data); }).catch(error => { if (active) setLoadError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [wallet.account, wallet.chainId, correctNetwork, refresh]);

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!wallet.account || !ready || !device.trim()) return;
    const started = identity;
    setBusy(true); setFormError(""); setFeedback("");
    try { const value = await quoteCoverage(wallet.account, amount); if (currentIdentity.current === started) setPremium(value); }
    catch (error) { if (currentIdentity.current === started) setFormError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function purchase() {
    if (!wallet.account || premium === null || !ready) return;
    const started = identity;
    const account = wallet.account;
    setBusy(true); setFormError("");
    try {
      const hash = await purchaseCoverage(account, device, amount, premium, message => { if (currentIdentity.current === started) setFeedback(message); });
      setActivities(items => [{ hash, account, amount, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...items]);
      if (currentIdentity.current === started) { setRefresh(value => value + 1); setPage("dashboard"); setDevice(""); setAmount(""); }
    } catch (error) { if (currentIdentity.current === started) { setFormError(errorText(error)); setFeedback(""); } }
    finally { setBusy(false); }
  }
  const personalActivity = activities.filter(item => item.account === wallet.account);
  const stats: { title: string; value: string; subtitle: string; icon: IconName; color: string }[] = [
    { title: "My wallet balance", value: money(overview?.balance), subtitle: "mUSDC available", icon: "wallet", color: "blue" },
    { title: "Community pool", value: money(overview?.pool), subtitle: "mUSDC in shared funds", icon: "pool", color: "purple" },
    { title: "Current payout cap", value: money(overview?.cap), subtitle: "mUSDC per claim · may change", icon: "shield", color: "orange" },
    { title: "My coverage", value: overview ? overview.active ? "Active" : "Not covered" : "—", subtitle: overview?.active ? `${money(overview.coverage)} mUSDC coverage` : "Your device protection", icon: "check", color: "green" }
  ];
  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" aria-label="TrustPool dashboard" href="#" onClick={event => { event.preventDefault(); setPage("dashboard"); }}><Icon name="shield" size={32} /><span>TrustPool<span className="brand-dot">.</span></span></a>
      <div className="profile"><div className="avatar">TP<i /></div><h2>{wallet.account ? "Pool member" : "Welcome, member"}</h2><p title={wallet.account ?? undefined}>{wallet.account ? short(wallet.account) : "Your protection starts here"}</p><span className="profile-tag">PERSONAL ACCOUNT</span></div>
      <nav aria-label="Main navigation"><button aria-label="Dashboard" className={page === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setPage("dashboard")}><Icon name="grid" /><span>Dashboard</span></button><button aria-label="Device Coverage" className={page === "coverage" ? "nav-item selected" : "nav-item"} onClick={() => setPage("coverage")}><Icon name="shield" /><span>Device Coverage</span></button></nav>
      <div className="sidebar-bottom"><Icon name="pool" /><h3>Protected, together.</h3><p>A shared pool.<br />A little more peace of mind.</p><div className="local-label"><i />Local prototype</div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div><span className="breadcrumb">PERSONAL WORKSPACE</span><p>Hello, {wallet.account ? "member" : "welcome back"} <span className="wave">✦</span></p></div><div className="topbar-actions"><span className={`network ${correctNetwork ? "online" : ""}`}><i />{correctNetwork ? "Hardhat Local" : wallet.account ? "Wrong network" : "Wallet not connected"}</span><button className="wallet-button" onClick={() => void wallet.connect()} disabled={wallet.isConnecting || Boolean(wallet.account)}><Icon name="wallet" size={17} />{wallet.account ? short(wallet.account) : wallet.isConnecting ? "Connecting…" : "Connect wallet"}</button></div></header>
    <main><div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL OVERVIEW</p><h1>{page === "dashboard" ? "Dashboard" : "Get device coverage"}</h1><p>{page === "dashboard" ? "A clear view of your coverage and the community behind it." : "Protect your device in a few simple steps."}</p></div>{page === "dashboard" && <button className="primary" onClick={() => setPage("coverage")}>Get Device Coverage <Icon name="arrow" size={18} /></button>}</div>
      {!wallet.account && <div className="connection-notice"><Icon name="wallet" /><div><strong>Make this space yours.</strong><p>{wallet.isMetaMaskAvailable ? "Connect your wallet to see your balance and device coverage." : "Open this app in a browser with MetaMask installed to connect your wallet."}</p></div>{wallet.isMetaMaskAvailable && <button className="text-button" disabled={wallet.isConnecting} onClick={() => void wallet.connect()}>Connect wallet →</button>}</div>}
      {wallet.account && !correctNetwork && <div className="notice warning" role="status">Switch MetaMask to Hardhat Local: RPC http://127.0.0.1:8545 · Chain ID 31337.</div>}
      {(wallet.error || loadError) && <div className="notice warning" role="alert">{wallet.error || loadError}{loadError && <button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button>}</div>}
      {loading && <p role="status" className="muted">Loading your on-chain information…</p>}
      {page === "dashboard" ? <>
        <section className="stats" aria-label="Account overview">{stats.map(stat => <article className="stat" key={stat.title}><div className="stat-top"><span>{stat.title}</span><span className={`icon-bubble ${stat.color}`}><Icon name={stat.icon} size={19} /></span></div><strong>{stat.value}</strong><small>{stat.subtitle}</small></article>)}</section>
        <div className="section-heading"><h2>My device coverage</h2><span>Your everyday essentials, protected.</span></div>
        <section className="coverage-grid"><article className="coverage-card"><div className="card-kicker"><span>● DEVICE PROTECTION</span><span className={`badge ${overview?.active ? "active" : ""}`}>{overview?.active ? "Active coverage" : "Get started"}</span></div><div className="coverage-content"><div className="device-art" aria-hidden="true"><div className="phone-shape"><div className="phone-camera" /><div className="phone-screen"><Icon name="shield" size={49} /></div><div className="phone-home" /></div><span className="device-check"><Icon name="check" size={18} /></span></div><div><h3>{overview?.active ? "Your device is covered." : "Big peace of mind.\nFor your everyday device."}</h3><p>{overview?.active ? `Coverage #${overview.policyId} · ${money(overview.coverage)} mUSDC protection. Your community is here when you need it.` : "Keep what keeps you connected protected. Choose your coverage and join a community that has your back."}</p>{overview?.active ? <p className="waiting">Claims eligible from {new Date((overview.startTime + overview.waitingPeriod) * 1000).toLocaleDateString()}</p> : <button className="primary" onClick={() => setPage("coverage")}>Protect my device <Icon name="arrow" size={18} /></button>}</div></div><div className="card-footer"><span><Icon name="check" size={15} />Transparent premiums</span><span><Icon name="check" size={15} />Community-powered</span></div></article>
        <article className="how-card"><span className="eyebrow">SIMPLE BY DESIGN</span><h3>A little cover.<br />A lot of confidence.</h3>{[["01", "Choose your coverage", "Tell us about your device and select an amount."], ["02", "Review your premium", "See exactly what you pay before confirming."], ["03", "You're part of the pool", "Your premium supports shared protection."]].map(([n, title, detail]) => <div className="how-step" key={n}><span>{n}</span><div><h4>{title}</h4><p>{detail}</p></div></div>)}</article></section>
        <div className="section-heading"><h2>Recent activity</h2><span>This session</span></div><section className="activity-card"><div className="activity-header"><span>Activity</span><span>Coverage amount</span><span>Status</span><span>Time</span></div>{personalActivity.length ? personalActivity.map(item => <div className="activity-row" key={item.hash}><div><strong>Device coverage purchased</strong><code title={item.hash}>{short(item.hash)}</code></div><span>{money(item.amount)} mUSDC</span><span className="badge active">Confirmed</span><span>{item.time}</span></div>) : <div className="empty-activity"><span className="empty-icon"><Icon name="shield" size={24} /></span><div><strong>Your next chapter starts here</strong><p>Coverage transactions completed here will appear in this session.</p></div></div>}</section>
      </> : <section className="purchase-grid"><form className="purchase-card" onSubmit={event => void review(event)}><span className="eyebrow">01 / YOUR DEVICE</span><h2>Coverage that fits.</h2><p className="muted">Choose how much protection your device needs.</p><label htmlFor="device">Device identifier</label><input id="device" value={device} onChange={event => { setDevice(event.target.value); setPremium(null); }} placeholder="e.g. device serial number" required maxLength={128} disabled={busy} /><small>The identifier is hashed before it is sent on-chain.</small><label htmlFor="amount">Desired coverage</label><div className="amount-input"><input id="amount" type="number" min="0.000001" step="0.000001" max={overview?.maxCoverage} value={amount} onChange={event => { setAmount(event.target.value); setPremium(null); }} placeholder="0.00" required disabled={busy} /><span>mUSDC</span></div><small>{overview ? `Maximum coverage: ${money(overview.maxCoverage)} mUSDC` : "Connect your wallet and local contracts to view available coverage."}</small><button className="primary full" type="submit" disabled={!ready || busy || overview?.active}>{busy ? "Please wait…" : "Review premium"}<Icon name="arrow" size={18} /></button>{overview?.active && <p className="notice">This wallet already has active device coverage.</p>}</form><aside className="summary-card"><span className="icon-bubble blue"><Icon name="shield" /></span><h2>Your coverage summary</h2><p className="muted">Everything upfront. No surprises.</p><dl><div><dt>Coverage amount</dt><dd>{amount ? money(amount) : "—"} mUSDC</dd></div><div><dt>Wallet balance</dt><dd>{money(overview?.balance)} mUSDC</dd></div><div className="premium-total"><dt>One-time premium</dt><dd>{premium === null ? "—" : money(premium)} <small>mUSDC</small></dd></div></dl><p className="summary-note">Approve the premium payment, then confirm your coverage in MetaMask. Both steps use local test funds.</p><button className="primary full" disabled={!ready || busy || premium === null || overview?.active} onClick={() => void purchase()}>{busy ? "Transaction in progress…" : "Approve & confirm coverage"}</button>{feedback && <p className="notice" role="status">{feedback}</p>}{formError && <p className="notice warning" role="alert">{formError}</p>}<button className="text-button back" onClick={() => setPage("dashboard")}>← Back to dashboard</button></aside></section>}
      <footer className="page-footer"><span>TrustPool · Protection starts with community.</span><span>Local test environment · No real funds</span></footer>
    </main></div>
  </div>;
}
