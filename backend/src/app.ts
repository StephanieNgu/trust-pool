import express, { type NextFunction, type Request, type Response } from "express";
import { isAddress, type Provider } from "ethers";
import { CLAIM_STATES, type ClaimState } from "./abis";
import { AUTH_HEADERS, AUTH_MAX_AGE_SECONDS, AuthError, authMessage, authenticate } from "./auth";
import type { Deployment, ProtocolContracts } from "./chain";
import { EvidenceError, LocalEvidenceStore, MAX_FILE_BYTES, MAX_FILES } from "./evidence";
import type { Keeper } from "./keeper";
import { getClaimView, getMemberView, getPoolView, listClaims } from "./protocol";

export interface AppDeps {
  deployment: Deployment;
  provider: Provider;
  /** Read-only contract instances. Users sign their own transactions in their wallet. */
  contracts: ProtocolContracts;
  evidence: LocalEvidenceStore;
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
   * Evidence is private. It is served to whoever uploaded it, and to the jurors of any claim that one
   * of its uploaders filed with it. A claim filed by someone else who copied the hash from the chain
   * grants nothing, so the hash being public does not make the files public.
   */
  async function requireEvidenceAccess(req: Request, evidenceHash: string): Promise<void> {
    const reader = wallet(req).toLowerCase();
    if (!(await evidence.has(evidenceHash))) throw new HttpError(404, "Evidence not found.");
    const uploaders = await evidence.getUploaders(evidenceHash);
    if (uploaders.includes(reader)) return;
    const claims = await listClaims(contracts, { evidenceHash });
    const isJuror = claims.some(
      (c) =>
        uploaders.includes(c.claimant.toLowerCase()) &&
        (c.jury?.jurors.some((j) => j.address.toLowerCase() === reader) ?? false),
    );
    if (!isJuror) {
      throw new HttpError(403, "Only the claimant and the claim's selected jurors can view this evidence.");
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

  app.get("/api/claims/:id", async (req, res) => {
    const claim = await getClaimView(contracts, parseClaimId(req.params.id));
    if (!claim) throw new HttpError(404, "Claim not found.");
    const available = await evidence.has(claim.evidenceHash);
    res.json({
      ...claim,
      evidence: { available, url: available ? `/api/evidence/${claim.evidenceHash}` : null },
    });
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

  app.post("/api/evidence", async (req, res) => {
    const uploader = wallet(req);
    if (!(await contracts.registry.isActive(uploader))) {
      throw new HttpError(403, "Only wallets with an active policy can upload evidence.");
    }
    const summary = await evidence.put(req.body, uploader);
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
    if (err instanceof HttpError || err instanceof EvidenceError || err instanceof AuthError) {
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
