import { displayAmount } from "./claims/presentation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { HARDHAT_LOCAL_CHAIN_ID, useWallet } from "./wallet";
import { authenticateWallet, clearWalletAuth, enrollDevice, getDashboardOverview, readCachedWalletAuth, validateDeviceDetails, type DashboardOverview } from "./api";
import { ClaimsPage } from "./claims/ClaimsPage";
import { JuryPage } from "./claims/JuryPage";
import { DeviceEnrollment, EMPTY_ENROLLMENT, enrollmentComplete, enrollmentDevice, enrollmentFiles, type EnrollmentDraft } from "./member/DeviceEnrollment";
import { PolicyActions } from "./member/PolicyActions";
import { PremiumPanel } from "./member/PremiumPanel";
import { PoolPage } from "./member/PoolPage";
import { AttentionList, NotificationBell, useNotifications } from "./member/Notifications";
import type { MemberNotification } from "./api";
import { createDeviceKey } from "./member/deviceKey";
import { AccountHistory } from "./member/AccountHistory";
import { ClaimSummary } from "./member/ClaimSummary";
import { PolicyTerms } from "./member/PolicyTerms";
import { initials, rememberSignupDevice, useDeviceLabel, useDisplayName } from "./member/memberIdentity";
import { purchaseCoverage, quoteCoverage } from "./contracts/insurance";
import { contractErrorMessage } from "./contracts/errors";

type IconName = "grid" | "shield" | "wallet" | "pool" | "arrow" | "check" | "users" | "doc";
function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const paths = { grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z", shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6", wallet: "M4 6V4h14v3 M3 7h18v14H3z M16 12h5v5h-5z", pool: "M3 7l9-4 9 4-9 4z M3 12l9 4 9-4 M3 17l9 4 9-4", arrow: "M4 12h16 M14 6l6 6-6 6", check: "M5 12l4 4L19 6", users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1 M16 3.5a4 4 0 0 1 0 7.5 M22 21v-1a6 6 0 0 0-4-5.6", doc: "M6 2h9l5 5v15H6z M14 2v6h6 M9 13h8 M9 17h8 M9 9h3" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const money = (value?: string) => value === undefined ? "—" : displayAmount(value);
function errorText(error: unknown) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ACTION_REJECTED" || error.code === 4001)) return "Request cancelled in your wallet. You can try again.";
  const reverted = contractErrorMessage(error);
  if (reverted) return reverted;
  if (error && typeof error === "object" && "shortMessage" in error) return String(error.shortMessage);
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function App() {
  const wallet = useWallet();
  const [page, setPage] = useState<"dashboard" | "pool" | "coverage" | "claims" | "jury" | "terms">("dashboard");
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
  const identity = `${wallet.account}:${wallet.chainId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const correctNetwork = wallet.chainId === HARDHAT_LOCAL_CHAIN_ID;
  const ready = Boolean(wallet.account && correctNetwork && overview);
  const deviceName = useDeviceLabel(wallet.account, overview?.enrollmentHash ?? null);
  const [displayName, setDisplayName] = useDisplayName(wallet.account);
  const [editingName, setEditingName] = useState(false);
  function openClaim(claimId: string) {
    setFocusClaim({ id: claimId, nonce: Date.now() });
    setPage("claims");
  }
  const notifications = useNotifications(wallet.account, Boolean(wallet.account && correctNetwork), refresh);
  // The claim a notification asked to open; the nonce reopens it if the same one is picked again.
  const [focusClaim, setFocusClaim] = useState<{ id: string; nonce: number } | null>(null);
  // The page consumes it in its own effect, which runs before this one; clearing it here keeps a later
  // visit to the page from reopening the claim.
  useEffect(() => { if (focusClaim) setFocusClaim(null); }, [focusClaim]);
  function openNotification(n: MemberNotification) {
    if (n.claimId) setFocusClaim({ id: n.claimId, nonce: Date.now() });
    setPage(n.kind === "jury" ? "jury" : n.kind === "claim" || n.id.endsWith(":eligible") ? "claims" : "dashboard");
  }

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
        const deviceKey = enrollment.onThisDevice ? await createDeviceKey(account) : undefined;
        const purchaseProof = enrollment.purchaseProof ? [enrollment.purchaseProof] : [];
        enrolled = (await enrollDevice(account, enrollmentDevice(enrollment), enrollmentFiles(enrollment), enrollment.captureCode?.code ?? "", { deviceKey, purchaseProof })).evidenceHash;
        if (currentIdentity.current === started) setEnrollmentHash(enrolled);
        setAuthStatus("authenticated");
      }
      await purchaseCoverage(account, enrollmentDevice(enrollment), amount, premium, enrolled, report);
      rememberSignupDevice(account, enrollmentDevice(enrollment));
      if (currentIdentity.current === started) { setRefresh(value => value + 1); setPage("dashboard"); setEnrollment(EMPTY_ENROLLMENT); setEnrollmentHash(null); setAmount(""); }
    } catch (error) { if (currentIdentity.current === started) { setFormError(errorText(error)); setFeedback(""); } }
    finally { setBusy(false); }
  }
  const tokenSymbol = overview?.tokenSymbol ?? "mUSDC";
  function premiumPaid() {
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
    jury: { eyebrow: "COMMUNITY REVIEW", title: "Jury queue", description: "Review claims assigned to this wallet and follow each voting window." },
    terms: { eyebrow: "POLICY TERMS", title: "What your cover includes", description: "What's covered, what isn't, and how premiums and claims work." }
  }[page];
  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" aria-label="TrustPool dashboard" href="#" onClick={event => { event.preventDefault(); setPage("dashboard"); }}><Icon name="shield" size={32} /><span>TrustPool<span className="brand-dot">.</span></span></a>
      <div className="profile"><div className="avatar">{initials(displayName)}<i /></div>{!wallet.account ? <h2>Welcome, member</h2> : editingName
        ? <input className="profile-name-input" aria-label="Your name" autoFocus defaultValue={displayName ?? ""} maxLength={40} placeholder="Your name" onBlur={(event) => { setDisplayName(event.target.value); setEditingName(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingName(false); }} />
        : <button className="profile-name" type="button" title="Change the name this browser shows" onClick={() => setEditingName(true)}>{displayName ?? "Pool member"}<small>{displayName ? "Edit name" : "Add your name"}</small></button>}<p title={wallet.account ?? undefined}>{wallet.account ? short(wallet.account) : "Your protection starts here"}</p><span className="profile-tag">PERSONAL ACCOUNT</span></div>
      <nav aria-label="Main navigation"><button aria-label="Dashboard" className={page === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setPage("dashboard")}><Icon name="grid" /><span>Dashboard</span></button><button aria-label="Community Pool" className={page === "pool" ? "nav-item selected" : "nav-item"} onClick={() => setPage("pool")}><Icon name="pool" /><span>Community Pool</span></button><button aria-label="Device Coverage" className={page === "coverage" ? "nav-item selected" : "nav-item"} onClick={() => setPage("coverage")}><Icon name="shield" /><span>Device Coverage</span></button><button aria-label="Claims" className={page === "claims" ? "nav-item selected" : "nav-item"} onClick={() => setPage("claims")}><Icon name="check" /><span>Claims</span></button><button aria-label="Jury Queue" className={page === "jury" ? "nav-item selected" : "nav-item"} onClick={() => setPage("jury")}><Icon name="users" /><span>Jury Queue</span></button><button aria-label="Policy Terms" className={page === "terms" ? "nav-item selected" : "nav-item"} onClick={() => setPage("terms")}><Icon name="doc" /><span>Policy Terms</span></button></nav>
      <div className="sidebar-bottom"><Icon name="pool" /><h3>Protected, together.</h3><p>A shared pool.<br />A little more peace of mind.</p><div className="local-label"><i />Local prototype</div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div><span className="breadcrumb">PERSONAL WORKSPACE</span><p>{wallet.account ? `Hello, ${displayName ?? "member"}` : "Hello, welcome back"} <span className="wave">✦</span></p></div><div className="topbar-actions"><span className={`network ${correctNetwork ? "online" : ""}`}><i />{correctNetwork ? "Hardhat Local" : wallet.account ? "Wrong network" : "Wallet not connected"}</span>{wallet.isDemoWallet && wallet.account && <label className="demo-account-picker"><span>Demo role</span><select aria-label="Demo account" value={wallet.account} onChange={(event) => wallet.selectDemoAccount(event.target.value)}>{wallet.demoAccounts.map((account) => <option key={account.id} value={account.address}>{account.label}</option>)}</select></label>}{wallet.account && correctNetwork && <NotificationBell state={notifications} onSelect={openNotification} />}{wallet.account && correctNetwork && <button className="wallet-button" onClick={() => authStatus === "authenticated" ? signOutOfBackend() : void signInToBackend()} disabled={authStatus === "signing"}><Icon name="check" size={17} />{authStatus === "authenticated" ? "Sign out" : authStatus === "signing" ? "Signing…" : "Sign in"}</button>}<button className="wallet-button" onClick={() => void wallet.connect()} disabled={wallet.isConnecting || Boolean(wallet.account)}><Icon name="wallet" size={17} />{wallet.account ? short(wallet.account) : wallet.isConnecting ? "Connecting…" : "Connect wallet"}</button></div></header>
    <main><div className="page-heading"><div><p className="eyebrow">{pageCopy.eyebrow}</p><h1>{pageCopy.title}</h1><p>{pageCopy.description}</p></div>{page === "dashboard" && !overview?.active && <button className="primary" onClick={() => setPage("coverage")}>Get Device Coverage <Icon name="arrow" size={18} /></button>}</div>
      {!wallet.account && <div className="connection-notice"><Icon name="wallet" /><div><strong>Make this space yours.</strong><p>{wallet.isDemoWallet ? "Connect the local Hardhat demo account to explore the prototype." : wallet.isMetaMaskAvailable ? "Connect your wallet to see your balance and device coverage." : "Open this app in a browser with MetaMask installed to connect your wallet."}</p></div>{wallet.isMetaMaskAvailable && <button className="text-button" disabled={wallet.isConnecting} onClick={() => void wallet.connect()}>{wallet.isDemoWallet ? "Connect demo account →" : "Connect wallet →"}</button>}</div>}
      {wallet.account && !correctNetwork && <div className="notice warning" role="status">Switch MetaMask to Hardhat Local: RPC http://127.0.0.1:8545 · Chain ID 31337.</div>}
      {(wallet.error || loadError || authError) && <div className="notice warning" role="alert">{wallet.error || loadError || authError}{loadError && <button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button>}</div>}
      {loading && <p role="status" className="muted">Loading your information from the TrustPool backend…</p>}
      {page === "dashboard" ? <>
        <section className="stats" aria-label="Account overview">{stats.map(stat => <article className="stat" key={stat.title}><div className="stat-top"><span>{stat.title}</span><span className={`icon-bubble ${stat.color}`}><Icon name={stat.icon} size={19} /></span></div><strong>{stat.value}</strong><small>{stat.subtitle}</small></article>)}</section>
        <AttentionList state={notifications} onSelect={openNotification} />
        <div className="section-heading"><h2>My device coverage</h2><span>Your everyday essentials, protected.</span></div>
        <section className="coverage-grid"><article className="coverage-card"><div className="card-kicker"><span>● DEVICE PROTECTION</span><span className={`badge ${overview?.active && overview.premium?.status !== "Grace" ? "active" : ""}`}>{overview?.active ? overview.premium?.status === "Grace" ? "Payment due" : "Active coverage" : overview?.overdue ? "Coverage ended" : "Get started"}</span></div><div className="coverage-content"><div className="device-art" aria-hidden="true"><div className="phone-shape"><div className="phone-camera" /><div className="phone-screen"><Icon name="shield" size={49} /></div><div className="phone-home" /></div><span className="device-check"><Icon name="check" size={18} /></span></div><div><h3>{overview?.active ? deviceName ? `Your ${deviceName} is covered.` : "Your device is covered." : "Big peace of mind.\nFor your everyday device."}</h3><p>{overview?.active ? `Coverage #${overview.policyId} · up to ${money(overview.coverage)} ${tokenSymbol} per claim.${deviceName ? "" : " Sign in to show your device's name here."}` : "Keep what keeps you connected protected. Choose your coverage and join a community that has your back."}</p>{overview?.active && wallet.account && overview ? <><p className="waiting">Claims eligible from {new Date((overview.startTime + overview.waitingPeriod) * 1000).toLocaleDateString()}</p>{overview.premium && <PremiumPanel account={wallet.account} ready={ready} premium={overview.premium} tokenSymbol={tokenSymbol} onPaid={premiumPaid} />}<PolicyActions account={wallet.account} ready={ready} overview={overview} onCancelled={() => setRefresh(value => value + 1)} /></> : <>{overview?.overdue && overview.premium && wallet.account && <PremiumPanel account={wallet.account} ready={ready} premium={overview.premium} tokenSymbol={tokenSymbol} onPaid={premiumPaid} />}<button className="primary" onClick={() => setPage("coverage")}>Protect my device <Icon name="arrow" size={18} /></button></>}</div></div><div className="card-footer"><span><Icon name="check" size={15} />Simple monthly premiums</span><span><Icon name="check" size={15} />Community-powered</span></div></article>
        {overview?.policyId && overview.policyId !== "0" && wallet.account ? <ClaimSummary account={wallet.account} ready={ready} refresh={refresh} openClaimId={overview.openClaimId} canFile={Boolean(overview.active && overview.pastWaitingPeriod && !overview.openClaimId)} tokenDecimals={overview.tokenDecimals} tokenSymbol={tokenSymbol} onOpenClaim={openClaim} onFileClaim={() => setPage("claims")} /> : <article className="how-card"><span className="eyebrow">SIMPLE BY DESIGN</span><h3>A little cover.<br />A lot of confidence.</h3>{[["01", "Choose your coverage", "Tell us about your device and select an amount."], ["02", "Review your premium", "See exactly what you pay each month before confirming."], ["03", "You're part of the pool", "Your premium supports shared protection."]].map(([n, title, detail]) => <div className="how-step" key={n}><span>{n}</span><div><h4>{title}</h4><p>{detail}</p></div></div>)}</article>}</section>
        <div className="section-heading"><h2>Account history</h2><span>From the blockchain</span></div><AccountHistory account={wallet.account} ready={ready} refresh={refresh} tokenDecimals={overview?.tokenDecimals ?? 6} tokenSymbol={tokenSymbol} onOpenClaim={openClaim} />
      </> : page === "pool" ? <PoolPage account={wallet.account} ready={ready} overview={overview} onContributed={() => setRefresh(value => value + 1)} /> : page === "coverage" ? <section className="purchase-grid"><form className="purchase-card" onSubmit={event => void review(event)}><span className="eyebrow">01 / YOUR DEVICE</span><h2>Coverage that fits.</h2><p className="muted">Choose how much protection your device needs.</p><DeviceEnrollment account={wallet.account} draft={enrollment} disabled={busy || !ready} onChange={draft => { setEnrollment(draft); setEnrollmentHash(null); setPremium(null); }} onAuthenticated={() => setAuthStatus("authenticated")} /><span className="eyebrow step-label">04 / COVERAGE</span><label htmlFor="amount">Desired coverage</label><div className="amount-input"><input id="amount" type="number" min="0.000001" step="0.000001" max={overview?.maxCoverage} value={amount} onChange={event => { setAmount(event.target.value); setPremium(null); }} placeholder="0.00" required disabled={busy} /><span>{tokenSymbol}</span></div><small>{overview ? `Maximum coverage: ${money(overview.maxCoverage)} ${tokenSymbol}` : "Connect your wallet and local contracts to view available coverage."}</small><button className="primary full" type="submit" disabled={!ready || busy || overview?.active}>{busy ? "Please wait…" : "Review premium"}<Icon name="arrow" size={18} /></button>{overview?.active && <p className="notice">This wallet already has active device coverage.</p>}</form><aside className="summary-card"><span className="icon-bubble blue"><Icon name="shield" /></span><h2>Your coverage summary</h2><p className="muted">One simple monthly price. No surprises.</p><dl><div><dt>Coverage amount</dt><dd>{amount ? money(amount) : "—"} {tokenSymbol}</dd></div><div><dt>Wallet balance</dt><dd>{money(overview?.balance)} {tokenSymbol}</dd></div><div className="premium-total"><dt>Monthly premium</dt><dd>{premium === null ? "—" : money(premium)} <small>{tokenSymbol}</small></dd></div></dl><p className="summary-note">Confirming pays the first month. Pay each month after that from your dashboard; if a payment is missed, coverage continues for a short grace period before it ends. {wallet.isDemoWallet ? "The demo wallet approves the premium payment, then confirms your coverage." : "Approve the premium payment, then confirm your coverage in MetaMask."} Both steps use local test funds.</p>{overview && <p className="summary-note">Claims are paid from the community pool, and one claim can take at most {overview.maxPayoutBps / 100}% of it: {money(overview.cap)} {tokenSymbol} right now. The cap grows as members join and contribute.</p>}<p className="summary-note">Covers a cracked screen, other accidental damage, liquid damage, theft and breakdown after the maker's warranty. Not loss or wear. <button className="text-button inline-link" type="button" onClick={() => setPage("terms")}>Read the policy terms</button></p><button className="primary full" disabled={!ready || busy || premium === null || overview?.active} onClick={() => void purchase()}>{busy ? "Transaction in progress…" : "Approve & confirm coverage"}</button>{feedback && <p className="notice" role="status">{feedback}</p>}{formError && <p className="notice warning" role="alert">{formError}</p>}<button className="text-button back" onClick={() => setPage("dashboard")}>← Back to dashboard</button></aside></section> : page === "claims" ? <ClaimsPage account={wallet.account} ready={ready} overview={overview} focusClaim={focusClaim} onAuthenticated={() => setAuthStatus("authenticated")} onSubmitted={() => setRefresh(value => value + 1)} onOpenTerms={() => setPage("terms")} /> : page === "terms" ? <PolicyTerms onGetCoverage={overview?.active ? undefined : () => setPage("coverage")} onFileClaim={overview?.active ? () => setPage("claims") : undefined} /> : <JuryPage account={wallet.account} ready={ready} overview={overview} focusClaim={focusClaim} onAuthenticated={() => setAuthStatus("authenticated")} onStakeChanged={() => setRefresh(value => value + 1)} />}
      <footer className="page-footer"><span>TrustPool · Protection starts with community.</span><span>{overview ? `Backend block ${overview.backendBlock} · Keeper ${overview.keeperRunning ? "online" : "off"}` : "Local test environment · No real funds"}</span></footer>
    </main></div>
  </div>;
}
