import express, { type NextFunction, type Request, type Response } from "express";
import { isAddress, type Provider } from "ethers";
import { CLAIM_STATES, type ClaimState } from "./abis";
import { AUTH_HEADERS, AUTH_MAX_AGE_SECONDS, AuthError, authMessage, authenticate } from "./auth";
import { CaptureChallenges, CaptureError } from "./capture";
import type { Deployment, ProtocolContracts } from "./chain";
import {
  deviceIdHash,
  encodeBundle,
  sameDevice,
  EvidenceError,
  LocalEvidenceStore,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./evidence";
import type { Keeper } from "./keeper";
import { buildNotifications } from "./notifications";
import { getClaimView, getMemberView, getPoolView, getPremiumView, listClaims } from "./protocol";

export interface AppDeps {
  deployment: Deployment;
  provider: Provider;
  /** Read-only contract instances. Users sign their own transactions in their wallet. */
  contracts: ProtocolContracts;
  evidence: LocalEvidenceStore;
  /** One-time photo capture codes; a fresh in-memory set by default. */
  captures?: CaptureChallenges;
  keeper?: Keeper | null;
  /** Value for Access-Control-Allow-Origin; omit to disable CORS headers. */
  corsOrigin?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, `${name} must be an address.`);
  return value;
}

function parseClaimId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, "Claim id must be a positive integer.");
  return id;
}

function parseHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new HttpError(400, "Evidence hash must be 0x followed by 64 hex characters.");
  }
  return value.toLowerCase();
}

export function createApp(deps: AppDeps) {
  const { deployment, provider, contracts, evidence, keeper } = deps;
  const captures = deps.captures ?? new CaptureChallenges();
  const app = express();
  app.disable("x-powered-by");

  if (deps.corsOrigin) {
    const origin = deps.corsOrigin;
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", ["Content-Type", ...Object.values(AUTH_HEADERS)].join(", "));
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  // Base64 inflates files by a third; leave headroom for the JSON around them.
  const evidenceLimit = Math.ceil(MAX_FILES * MAX_FILE_BYTES * 1.4);
  app.use("/api/evidence", express.json({ limit: evidenceLimit }), (_req, res, next) => {
    // Evidence is per-wallet; never let a shared cache keep a copy.
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  // ---------------------------------------------------------------------------
  // Service and protocol info
  // ---------------------------------------------------------------------------

  /** The wallet whose signature authenticates this request, or a 401. */
  const wallet = (req: Request) => authenticate((name) => req.get(name), deployment.chainId);

  /**
   * Evidence is private. It is served to whoever uploaded it, and to the jurors of a claim that one of
   * its uploaders filed with it, only while that claim is being voted on. That covers both the claim's
   * own photos and the enrollment photos of the policy it was filed on, which jurors compare against.
   * A claim filed by someone else who copied the hash from the chain grants nothing, so the hash being
   * public does not make the files public. Other members, past jurors and anonymous callers get a 403.
   */
  async function requireEvidenceAccess(req: Request, evidenceHash: string): Promise<void> {
    const reader = wallet(req).toLowerCase();
    if (!(await evidence.has(evidenceHash))) throw new HttpError(404, "Evidence not found.");
    const uploaders = await evidence.getUploaders(evidenceHash);
    if (uploaders.includes(reader)) return;
    const claims = await listClaims(contracts, { juror: reader, state: "Voting" });
    const isJuror = claims.some(
      (c) =>
        (c.evidenceHash.toLowerCase() === evidenceHash || c.enrollmentHash?.toLowerCase() === evidenceHash) &&
        uploaders.includes(c.claimant.toLowerCase()),
    );
    if (!isJuror) {
      throw new HttpError(
        403,
        "Only the claimant, and the claim's selected jurors while voting is open, can view this evidence.",
      );
    }
  }

  app.get("/api/health", async (_req, res) => {
    const [network, blockNumber] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
    res.json({ ok: true, chainId: network.chainId.toString(), blockNumber, keeper: keeper?.status() ?? null });
  });

  app.get("/api/config", async (_req, res) => {
    const [symbol, decimals] = await Promise.all([contracts.token.symbol(), contracts.token.decimals()]);
    res.json({
      network: deployment.network,
      chainId: deployment.chainId,
      addresses: deployment.addresses,
      params: deployment.params,
      token: { symbol, decimals: Number(decimals) },
      claimStates: CLAIM_STATES.slice(1),
    });
  });

  app.get("/api/pool", async (_req, res) => {
    res.json(await getPoolView(contracts));
  });

  app.get("/api/members/:address", async (req, res) => {
    res.json(await getMemberView(contracts, parseAddress(req.params.address, "address")));
  });

  /**
   * Just the member's premium schedule: status, amount, due date and grace deadline. Light enough to
   * poll for reminders. `premium` is null for a wallet that never held a policy.
   */
  app.get("/api/members/:address/premium", async (req, res) => {
    res.json({ premium: await getPremiumView(contracts, parseAddress(req.params.address, "address")) });
  });

  /**
   * In-app notifications for a wallet: jury duty (picked, commit and reveal deadlines, outcome), its
   * own claims' status, and its policy. Built from public chain state, so no signature is needed.
   */
  app.get("/api/members/:address/notifications", async (req, res) => {
    const address = parseAddress(req.params.address, "address");
    const me = address.toLowerCase();
    const [member, claims, block, symbol, decimals, commitPeriod, responsePeriod] = await Promise.all([
      getMemberView(contracts, address),
      listClaims(contracts),
      provider.getBlock("latest"),
      contracts.token.symbol() as Promise<string>,
      contracts.token.decimals(),
      contracts.jury.commitPeriod() as Promise<bigint>,
      contracts.claimManager.responsePeriod() as Promise<bigint>,
    ]);
    const mine = claims.filter(
      (c) => c.claimant.toLowerCase() === me || (c.jury?.jurors.some((j) => j.address.toLowerCase() === me) ?? false),
    );
    const now = block?.timestamp ?? Math.floor(Date.now() / 1000);
    const notifications = buildNotifications({
      address,
      now,
      token: { symbol, decimals: Number(decimals) },
      claims: mine,
      policy: member.policy,
      juror: member.juror,
      commitPeriod: Number(commitPeriod),
      responsePeriod: Number(responsePeriod),
    });
    res.json({ now, notifications });
  });

  // ---------------------------------------------------------------------------
  // Claims and juries
  // ---------------------------------------------------------------------------

  app.get("/api/claims", async (req, res) => {
    const { claimant, juror, state } = req.query;
    if (state !== undefined && !(CLAIM_STATES as readonly unknown[]).includes(state)) {
      throw new HttpError(400, `state must be one of ${CLAIM_STATES.slice(1).join(", ")}.`);
    }
    const claims = await listClaims(contracts, {
      claimant: claimant === undefined ? undefined : parseAddress(claimant, "claimant"),
      juror: juror === undefined ? undefined : parseAddress(juror, "juror"),
      state: state as ClaimState | undefined,
    });
    res.json({ claims });
  });

  /**
   * Automatic checks shown to jurors next to the photos. Only yes/no answers are public; the IMEIs
   * and serials themselves stay in the private bundles. null means there was nothing to compare.
   */
  async function checkDevice(claimant: string, claimHash: string, enrollmentHash: string | null) {
    const enrolled = enrollmentHash ? await evidence.getDevice(enrollmentHash) : null;
    const claimed = (await evidence.has(claimHash)) ? await evidence.getDevice(claimHash) : null;
    let enrollmentMatchesPolicy: boolean | null = null;
    if (enrolled) {
      const policy = await contracts.registry.getPolicy(claimant);
      enrollmentMatchesPolicy = deviceIdHash(enrolled) === policy.deviceIdHash;
    }
    return { enrollmentMatchesPolicy, claimMatchesEnrollment: sameDevice(claimed, enrolled) };
  }

  app.get("/api/claims/:id", async (req, res) => {
    const claim = await getClaimView(contracts, parseClaimId(req.params.id));
    if (!claim) throw new HttpError(404, "Claim not found.");
    const available = await evidence.has(claim.evidenceHash);
    const enrollmentAvailable = claim.enrollmentHash !== null && (await evidence.has(claim.enrollmentHash));
    res.json({
      ...claim,
      evidence: { available, url: available ? `/api/evidence/${claim.evidenceHash}` : null },
      enrollment: {
        available: enrollmentAvailable,
        url: enrollmentAvailable ? `/api/evidence/${claim.enrollmentHash}` : null,
      },
      deviceCheck: await checkDevice(claim.claimant, claim.evidenceHash, enrollmentAvailable ? claim.enrollmentHash : null),
    });
  });

  /**
   * A juror's note, sent before they seal their vote. Returns the hash to seal with the amount
   * (JuryModule.computeCommitment). The text stays private until the juror reveals.
   */
  app.post("/api/claims/:id/notes", async (req, res) => {
    const juror = wallet(req);
    const claim = await getClaimView(contracts, parseClaimId(req.params.id));
    if (!claim) throw new HttpError(404, "Claim not found.");
    const seat = claim.jury?.jurors.find((j) => j.address.toLowerCase() === juror.toLowerCase());
    if (claim.state !== "Voting" || !seat) {
      throw new HttpError(403, "Only the claim's jurors can add a note, while voting is open.");
    }
    if (seat.committed) throw new HttpError(409, "Your vote is already sealed, and its note with it.");
    const noteHash = await evidence.putNote(Number(claim.id), juror, (req.body as { note?: unknown } | undefined)?.note);
    res.status(201).json({ noteHash });
  });

  /**
   * Revealed votes with each juror's amount and note. The amounts are public on-chain; the notes are
   * shown only to the claimant and the claim's jurors, since they may describe the evidence.
   */
  app.get("/api/claims/:id/votes", async (req, res) => {
    const reader = wallet(req).toLowerCase();
    const claim = await getClaimView(contracts, parseClaimId(req.params.id));
    if (!claim) throw new HttpError(404, "Claim not found.");
    const jurors = claim.jury?.jurors ?? [];
    if (claim.claimant.toLowerCase() !== reader && !jurors.some((j) => j.address.toLowerCase() === reader)) {
      throw new HttpError(403, "Only the claimant and the claim's jurors can read the jurors' notes.");
    }
    const votes = await Promise.all(
      jurors
        .filter((j) => j.revealed)
        .map(async (j) => ({
          juror: j.address,
          amount: j.amount,
          note: j.noteHash ? await evidence.getNote(Number(claim.id), j.address, j.noteHash) : null,
        })),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ votes });
  });

  // ---------------------------------------------------------------------------
  // Evidence: wallet-authenticated. Upload returns the hash to pass to ClaimManager.submitClaim.
  // ---------------------------------------------------------------------------

  /** The message a wallet signs to use the evidence routes, valid for AUTH_MAX_AGE_SECONDS. */
  app.get("/api/auth/message", (req, res) => {
    const address = parseAddress(req.query.address, "address");
    const issuedAt = Math.floor(Date.now() / 1000);
    res.json({
      message: authMessage(address, deployment.chainId, issuedAt),
      issuedAt,
      expiresAt: issuedAt + AUTH_MAX_AGE_SECONDS,
      headers: AUTH_HEADERS,
    });
  });

  /**
   * A one-time code to show in the photos about to be taken. Upload them with it as `captureCode`
   * within CAPTURE_CODE_TTL_SECONDS.
   */
  app.post("/api/capture/code", (req, res) => {
    res.status(201).json(captures.issue(wallet(req)));
  });

  /**
   * Upload a bundle. `kind: "enrollment"` (device details and signup photos) is open to any signed-in
   * wallet, since it comes before buying a policy; its hash is passed to PolicyRegistry.buyPolicy.
   * `kind: "claim"` (the default) needs an active policy; its hash is passed to submitClaim.
   */
  app.post("/api/evidence", async (req, res) => {
    const uploader = wallet(req);
    const kind = (req.body as { kind?: unknown } | undefined)?.kind ?? "claim";
    if (kind === "claim" && !(await contracts.registry.isActive(uploader))) {
      throw new HttpError(403, "Only wallets with an active policy can upload claim evidence.");
    }
    // Validate before using up the capture code, so a mistake in the form does not cost a retake.
    encodeBundle(req.body);
    const capture = captures.consume(uploader, (req.body as { captureCode?: unknown }).captureCode);
    const summary = await evidence.put(req.body, uploader, capture);
    res.status(201).json(summary);
  });

  app.get("/api/evidence/:hash", async (req, res) => {
    const hash = parseHash(req.params.hash);
    await requireEvidenceAccess(req, hash);
    const summary = await evidence.getSummary(hash);
    if (!summary) throw new HttpError(404, "Evidence not found.");
    res.json({
      ...summary,
      rawUrl: `/api/evidence/${summary.evidenceHash}/raw`,
      files: summary.files.map((f) => ({ ...f, url: `/api/evidence/${summary.evidenceHash}/files/${f.index}` })),
    });
  });

  /** Exact stored bytes. keccak256 of this body equals the claim's on-chain evidenceHash. */
  app.get("/api/evidence/:hash/raw", async (req, res) => {
    const hash = parseHash(req.params.hash);
    await requireEvidenceAccess(req, hash);
    const raw = await evidence.getRaw(hash);
    if (!raw) throw new HttpError(404, "Evidence not found.");
    res.type("application/json").send(raw);
  });

  app.get("/api/evidence/:hash/files/:index", async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0) throw new HttpError(400, "File index must be a whole number.");
    const hash = parseHash(req.params.hash);
    await requireEvidenceAccess(req, hash);
    const file = await evidence.getFile(hash, index);
    if (!file) throw new HttpError(404, "Evidence file not found.");
    // User-supplied content: never let the browser sniff it into something executable.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", `inline; filename="${file.info.name.replace(/[^\w.-]/g, "_")}"`);
    res.type(file.info.contentType).send(file.data);
  });

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof HttpError || err instanceof EvidenceError || err instanceof AuthError || err instanceof CaptureError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === "entity.too.large" || e.type === "entity.parse.failed") {
      res.status(e.status ?? 400).json({ error: e.message });
      return;
    }
    console.error(err);
    res.status(502).json({ error: "Could not read from the chain or storage." });
  });

  return app;
}
