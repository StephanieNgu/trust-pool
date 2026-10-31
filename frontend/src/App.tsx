import { useEffect, useRef, useState, type FormEvent } from "react";
import { HARDHAT_LOCAL_CHAIN_ID, useWallet } from "./wallet";
import { authenticateWallet, clearWalletAuth, enrollDevice, getDashboardOverview, readCachedWalletAuth, validateDeviceDetails, type DashboardOverview } from "./api";
import { ClaimsPage } from "./claims/ClaimsPage";
import { JuryPage } from "./claims/JuryPage";
import { DeviceEnrollment, EMPTY_ENROLLMENT, enrollmentComplete, enrollmentDevice, enrollmentFiles, type EnrollmentDraft } from "./member/DeviceEnrollment";
import { PolicyActions } from "./member/PolicyActions";
import { PremiumPanel } from "./member/PremiumPanel";
import { PoolPage } from "./member/PoolPage";
import { purchaseCoverage, quoteCoverage } from "./contracts/insurance";

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
  const [page, setPage] = useState<"dashboard" | "pool" | "coverage" | "claims" | "jury">("dashboard");
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [enrollment, setEnrollment] = useState<EnrollmentDraft>(EMPTY_ENROLLMENT);
  // Set once the signup photos are uploaded, so a failed purchase can be retried without retaking them.
  const [enrollmentHash, setEnrollmentHash] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [premium, setPremium] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [formError, setFormError] = useState("");
  const [authStatus, setAuthStatus] = useState<"idle" | "signing" | "authenticated">("idle");
  const [authError, setAuthError] = useState("");
  const [activities, setActivities] = useState<{ hash: string; account: string; title: string; amount?: string; time: string }[]>([]);
  const identity = `${wallet.account}:${wallet.chainId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const correctNetwork = wallet.chainId === HARDHAT_LOCAL_CHAIN_ID;
  const ready = Boolean(wallet.account && correctNetwork && overview);

  useEffect(() => {
    setOverview(null); setLoadError(""); setPremium(null); setFeedback(""); setFormError(""); setEnrollment(EMPTY_ENROLLMENT); setEnrollmentHash(null);
  }, [wallet.account, wallet.chainId]);

  useEffect(() => {
    let active = true;
    setLoadError("");
    if (!wallet.account || !correctNetwork) { setLoading(false); return; }
    setLoading(true);
    void getDashboardOverview(wallet.account).then(data => { if (active) setOverview(data); }).catch(error => { if (active) setLoadError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [wallet.account, wallet.chainId, correctNetwork, refresh]);

  useEffect(() => {
    if (!wallet.account || !correctNetwork) return;
    let active = true;
    const account = wallet.account;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void getDashboardOverview(account)
        .then((data) => { if (active) setOverview(data); })
        .catch(() => { /* Keep the last good snapshot during a background refresh. */ });
    }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [wallet.account, correctNetwork]);

  useEffect(() => {
    setAuthError("");
    setAuthStatus(wallet.account && correctNetwork && readCachedWalletAuth(wallet.account) ? "authenticated" : "idle");
  }, [wallet.account, wallet.chainId, correctNetwork]);

  async function signInToBackend() {
    if (!wallet.account || !correctNetwork) return;
    const started = identity;
    setAuthStatus("signing");
    setAuthError("");
    try {
      await authenticateWallet(wallet.account);
      if (currentIdentity.current === started) setAuthStatus("authenticated");
    } catch (error) {
      if (currentIdentity.current === started) {
        setAuthStatus("idle");
        setAuthError(errorText(error));
      }
    }
  }

  function signOutOfBackend() {
    if (!wallet.account) return;
    clearWalletAuth(wallet.account);
    setAuthStatus("idle");
    setAuthError("");
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!wallet.account || !ready) return;
    const started = identity;
    setBusy(true); setFormError(""); setFeedback("");
    try {
      validateDeviceDetails(enrollmentDevice(enrollment));
      if (!enrollmentComplete(enrollment)) throw new Error("Get a capture code and take all three photos of the device.");
      const value = await quoteCoverage(wallet.account, amount); if (currentIdentity.current === started) setPremium(value); }
    catch (error) { if (currentIdentity.current === started) setFormError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function purchase() {
    if (!wallet.account || premium === null || !ready) return;
    const started = identity;
    const account = wallet.account;
    setBusy(true); setFormError("");
    try {
      const report = (message: string) => { if (currentIdentity.current === started) setFeedback(message); };
      let enrolled = enrollmentHash;
      if (!enrolled) {
        report("Uploading your device photos…");
        enrolled = (await enrollDevice(account, enrollmentDevice(enrollment), enrollmentFiles(enrollment), enrollment.captureCode?.code ?? "")).evidenceHash;
        if (currentIdentity.current === started) setEnrollmentHash(enrolled);
        setAuthStatus("authenticated");
      }
      const hash = await purchaseCoverage(account, enrollmentDevice(enrollment), amount, premium, enrolled, report);
      setActivities(items => [{ hash, account, title: "Device coverage purchased", amount, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...items]);
      if (currentIdentity.current === started) { setRefresh(value => value + 1); setPage("dashboard"); setEnrollment(EMPTY_ENROLLMENT); setEnrollmentHash(null); setAmount(""); }
    } catch (error) { if (currentIdentity.current === started) { setFormError(errorText(error)); setFeedback(""); } }
    finally { setBusy(false); }
  }
  const personalActivity = activities.filter(item => item.account === wallet.account);
  const tokenSymbol = overview?.tokenSymbol ?? "mUSDC";
  function premiumPaid(hash: string, paidAmount: string) {
    if (wallet.account) setActivities(items => [{ hash, account: wallet.account!, title: "Monthly premium paid", amount: paidAmount, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...items]);
    setRefresh(value => value + 1);
  }
  const stats: { title: string; value: string; subtitle: string; icon: IconName; color: string }[] = [
    { title: "My wallet balance", value: money(overview?.balance), subtitle: `${tokenSymbol} available`, icon: "wallet", color: "blue" },
    { title: "Community pool", value: money(overview?.pool), subtitle: `${tokenSymbol} in shared funds`, icon: "pool", color: "purple" },
    { title: "Current payout cap", value: money(overview?.cap), subtitle: `${tokenSymbol} per claim · may change`, icon: "shield", color: "orange" },
    { title: "My coverage", value: overview ? overview.active ? "Active" : "Not covered" : "—", subtitle: overview?.active ? `${money(overview.coverage)} ${tokenSymbol} coverage` : "Your device protection", icon: "check", color: "green" }
  ];
  const pageCopy = {
    dashboard: { eyebrow: "YOUR PERSONAL OVERVIEW", title: "Dashboard", description: "A clear view of your coverage and the community behind it." },
    pool: { eyebrow: "COMMUNITY POOL", title: "Community pool", description: "See the shared reserve and make a voluntary contribution." },
    coverage: { eyebrow: "DEVICE PROTECTION", title: "Get device coverage", description: "Protect your device in a few simple steps." },
    claims: { eyebrow: "CLAIMS", title: "Claims", description: "Submit evidence and follow your claim through the community review process." },
    jury: { eyebrow: "COMMUNITY REVIEW", title: "Jury queue", description: "Review claims assigned to this wallet and follow each voting window." }
  }[page];
  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" aria-label="TrustPool dashboard" href="#" onClick={event => { event.preventDefault(); setPage("dashboard"); }}><Icon name="shield" size={32} /><span>TrustPool<span className="brand-dot">.</span></span></a>
      <div className="profile"><div className="avatar">TP<i /></div><h2>{wallet.account ? "Pool member" : "Welcome, member"}</h2><p title={wallet.account ?? undefined}>{wallet.account ? short(wallet.account) : "Your protection starts here"}</p><span className="profile-tag">PERSONAL ACCOUNT</span></div>
      <nav aria-label="Main navigation"><button aria-label="Dashboard" className={page === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setPage("dashboard")}><Icon name="grid" /><span>Dashboard</span></button><button aria-label="Community Pool" className={page === "pool" ? "nav-item selected" : "nav-item"} onClick={() => setPage("pool")}><Icon name="pool" /><span>Community Pool</span></button><button aria-label="Device Coverage" className={page === "coverage" ? "nav-item selected" : "nav-item"} onClick={() => setPage("coverage")}><Icon name="shield" /><span>Device Coverage</span></button><button aria-label="Claims" className={page === "claims" ? "nav-item selected" : "nav-item"} onClick={() => setPage("claims")}><Icon name="check" /><span>Claims</span></button><button aria-label="Jury Queue" className={page === "jury" ? "nav-item selected" : "nav-item"} onClick={() => setPage("jury")}><Icon name="pool" /><span>Jury Queue</span></button></nav>
      <div className="sidebar-bottom"><Icon name="pool" /><h3>Protected, together.</h3><p>A shared pool.<br />A little more peace of mind.</p><div className="local-label"><i />Local prototype</div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div><span className="breadcrumb">PERSONAL WORKSPACE</span><p>Hello, {wallet.account ? "member" : "welcome back"} <span className="wave">✦</span></p></div><div className="topbar-actions"><span className={`network ${correctNetwork ? "online" : ""}`}><i />{correctNetwork ? "Hardhat Local" : wallet.account ? "Wrong network" : "Wallet not connected"}</span>{wallet.isDemoWallet && wallet.account && <label className="demo-account-picker"><span>Demo role</span><select aria-label="Demo account" value={wallet.account} onChange={(event) => wallet.selectDemoAccount(event.target.value)}>{wallet.demoAccounts.map((account) => <option key={account.id} value={account.address}>{account.label}</option>)}</select></label>}{wallet.account && correctNetwork && <button className="wallet-button" onClick={() => authStatus === "authenticated" ? signOutOfBackend() : void signInToBackend()} disabled={authStatus === "signing"}><Icon name="check" size={17} />{authStatus === "authenticated" ? "Sign out" : authStatus === "signing" ? "Signing…" : "Sign in"}</button>}<button className="wallet-button" onClick={() => void wallet.connect()} disabled={wallet.isConnecting || Boolean(wallet.account)}><Icon name="wallet" size={17} />{wallet.account ? short(wallet.account) : wallet.isConnecting ? "Connecting…" : "Connect wallet"}</button></div></header>
    <main><div className="page-heading"><div><p className="eyebrow">{pageCopy.eyebrow}</p><h1>{pageCopy.title}</h1><p>{pageCopy.description}</p></div>{page === "dashboard" && <button className="primary" onClick={() => setPage("coverage")}>Get Device Coverage <Icon name="arrow" size={18} /></button>}</div>
      {!wallet.account && <div className="connection-notice"><Icon name="wallet" /><div><strong>Make this space yours.</strong><p>{wallet.isDemoWallet ? "Connect the local Hardhat demo account to explore the prototype." : wallet.isMetaMaskAvailable ? "Connect your wallet to see your balance and device coverage." : "Open this app in a browser with MetaMask installed to connect your wallet."}</p></div>{wallet.isMetaMaskAvailable && <button className="text-button" disabled={wallet.isConnecting} onClick={() => void wallet.connect()}>{wallet.isDemoWallet ? "Connect demo account →" : "Connect wallet →"}</button>}</div>}
      {wallet.account && !correctNetwork && <div className="notice warning" role="status">Switch MetaMask to Hardhat Local: RPC http://127.0.0.1:8545 · Chain ID 31337.</div>}
      {(wallet.error || loadError || authError) && <div className="notice warning" role="alert">{wallet.error || loadError || authError}{loadError && <button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button>}</div>}
      {loading && <p role="status" className="muted">Loading your information from the TrustPool backend…</p>}
      {page === "dashboard" ? <>
        <section className="stats" aria-label="Account overview">{stats.map(stat => <article className="stat" key={stat.title}><div className="stat-top"><span>{stat.title}</span><span className={`icon-bubble ${stat.color}`}><Icon name={stat.icon} size={19} /></span></div><strong>{stat.value}</strong><small>{stat.subtitle}</small></article>)}</section>
        <div className="section-heading"><h2>My device coverage</h2><span>Your everyday essentials, protected.</span></div>
        <section className="coverage-grid"><article className="coverage-card"><div className="card-kicker"><span>● DEVICE PROTECTION</span><span className={`badge ${overview?.active && overview.premium?.status !== "Grace" ? "active" : ""}`}>{overview?.active ? overview.premium?.status === "Grace" ? "Premium overdue" : "Active coverage" : overview?.overdue ? "Coverage ended" : "Get started"}</span></div><div className="coverage-content"><div className="device-art" aria-hidden="true"><div className="phone-shape"><div className="phone-camera" /><div className="phone-screen"><Icon name="shield" size={49} /></div><div className="phone-home" /></div><span className="device-check"><Icon name="check" size={18} /></span></div><div><h3>{overview?.active ? "Your device is covered." : "Big peace of mind.\nFor your everyday device."}</h3><p>{overview?.active ? `Coverage #${overview.policyId} · ${money(overview.coverage)} mUSDC protection. Your community is here when you need it.` : "Keep what keeps you connected protected. Choose your coverage and join a community that has your back."}</p>{overview?.active && wallet.account && overview ? <><p className="waiting">Claims eligible from {new Date((overview.startTime + overview.waitingPeriod) * 1000).toLocaleDateString()}</p>{overview.premium && <PremiumPanel account={wallet.account} ready={ready} premium={overview.premium} tokenSymbol={tokenSymbol} onPaid={premiumPaid} />}<PolicyActions account={wallet.account} ready={ready} overview={overview} onCancelled={(hash) => { setActivities(items => [{ hash, account: wallet.account!, title: "Device coverage cancelled", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...items]); setRefresh(value => value + 1); }} /></> : <>{overview?.overdue && overview.premium && wallet.account && <PremiumPanel account={wallet.account} ready={ready} premium={overview.premium} tokenSymbol={tokenSymbol} onPaid={premiumPaid} />}<button className="primary" onClick={() => setPage("coverage")}>Protect my device <Icon name="arrow" size={18} /></button></>}</div></div><div className="card-footer"><span><Icon name="check" size={15} />Simple monthly premiums</span><span><Icon name="check" size={15} />Community-powered</span></div></article>
        <article className="how-card"><span className="eyebrow">SIMPLE BY DESIGN</span><h3>A little cover.<br />A lot of confidence.</h3>{[["01", "Choose your coverage", "Tell us about your device and select an amount."], ["02", "Review your premium", "See exactly what you pay each month before confirming."], ["03", "You're part of the pool", "Your premium supports shared protection."]].map(([n, title, detail]) => <div className="how-step" key={n}><span>{n}</span><div><h4>{title}</h4><p>{detail}</p></div></div>)}</article></section>
        <div className="section-heading"><h2>Recent activity</h2><span>This session</span></div><section className="activity-card"><div className="activity-header"><span>Activity</span><span>Amount</span><span>Status</span><span>Time</span></div>{personalActivity.length ? personalActivity.map(item => <div className="activity-row" key={item.hash}><div><strong>{item.title}</strong><code title={item.hash}>{short(item.hash)}</code></div><span>{item.amount ? `${money(item.amount)} mUSDC` : "—"}</span><span className="badge active">Confirmed</span><span>{item.time}</span></div>) : <div className="empty-activity"><span className="empty-icon"><Icon name="shield" size={24} /></span><div><strong>Your next chapter starts here</strong><p>Transactions completed here will appear in this session.</p></div></div>}</section>
      </> : page === "pool" ? <PoolPage account={wallet.account} ready={ready} overview={overview} onContributed={(hash, contributedAmount) => { if (wallet.account) setActivities(items => [{ hash, account: wallet.account!, title: "Community pool contribution", amount: contributedAmount, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...items]); setRefresh(value => value + 1); }} /> : page === "coverage" ? <section className="purchase-grid"><form className="purchase-card" onSubmit={event => void review(event)}><span className="eyebrow">01 / YOUR DEVICE</span><h2>Coverage that fits.</h2><p className="muted">Choose how much protection your device needs.</p><DeviceEnrollment account={wallet.account} draft={enrollment} disabled={busy || !ready} onChange={draft => { setEnrollment(draft); setEnrollmentHash(null); setPremium(null); }} onAuthenticated={() => setAuthStatus("authenticated")} /><label htmlFor="amount">Desired coverage</label><div className="amount-input"><input id="amount" type="number" min="0.000001" step="0.000001" max={overview?.maxCoverage} value={amount} onChange={event => { setAmount(event.target.value); setPremium(null); }} placeholder="0.00" required disabled={busy} /><span>{tokenSymbol}</span></div><small>{overview ? `Maximum coverage: ${money(overview.maxCoverage)} ${tokenSymbol}` : "Connect your wallet and local contracts to view available coverage."}</small><button className="primary full" type="submit" disabled={!ready || busy || overview?.active}>{busy ? "Please wait…" : "Review premium"}<Icon name="arrow" size={18} /></button>{overview?.active && <p className="notice">This wallet already has active device coverage.</p>}</form><aside className="summary-card"><span className="icon-bubble blue"><Icon name="shield" /></span><h2>Your coverage summary</h2><p className="muted">One simple monthly price. No surprises.</p><dl><div><dt>Coverage amount</dt><dd>{amount ? money(amount) : "—"} {tokenSymbol}</dd></div><div><dt>Wallet balance</dt><dd>{money(overview?.balance)} {tokenSymbol}</dd></div><div className="premium-total"><dt>Monthly premium</dt><dd>{premium === null ? "—" : money(premium)} <small>{tokenSymbol}</small></dd></div></dl><p className="summary-note">Confirming pays the first month. Pay each month after that from your dashboard; if a payment is missed, coverage continues for a short grace period before it ends. Approve the premium payment, then confirm your coverage in MetaMask. Both steps use local test funds.</p><button className="primary full" disabled={!ready || busy || premium === null || overview?.active} onClick={() => void purchase()}>{busy ? "Transaction in progress…" : "Approve & confirm coverage"}</button>{feedback && <p className="notice" role="status">{feedback}</p>}{formError && <p className="notice warning" role="alert">{formError}</p>}<button className="text-button back" onClick={() => setPage("dashboard")}>← Back to dashboard</button></aside></section> : page === "claims" ? <ClaimsPage account={wallet.account} ready={ready} overview={overview} onAuthenticated={() => setAuthStatus("authenticated")} onSubmitted={() => setRefresh(value => value + 1)} /> : <JuryPage account={wallet.account} ready={ready} overview={overview} onAuthenticated={() => setAuthStatus("authenticated")} onStakeChanged={() => setRefresh(value => value + 1)} />}
      <footer className="page-footer"><span>TrustPool · Protection starts with community.</span><span>{overview ? `Backend block ${overview.backendBlock} · Keeper ${overview.keeperRunning ? "online" : "off"}` : "Local test environment · No real funds"}</span></footer>
    </main></div>
  </div>;
}
