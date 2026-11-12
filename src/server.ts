// Verdict Desk storefront server (Node built-in http, no runtime
// dependencies). Surfaces:
//   /                      the desk: paste or fetch a posting, free verdict
//   /desk/:id              the verdict card (free view; full when unlocked)
//   /desk/:id/full         the paid full evaluation (locked until capture)
//   /desk/:id/recheck/:rid a completed paid recheck, with verdict movement
//   /receipt/:orderId      the receipt view for an order
//   /checkout/return       PayPal return: capture, unlock, redirect
//   /checkout/cancel       buyer cancelled at PayPal
//   /stub/checkout/:id     LOCAL STUB approval page (stub mode only)
//   /api/...               JSON endpoints used by the pages and the SDK
//   /api/webhooks/paypal   webhook confirmation endpoint
//
// Exposure and abuse guards from the plan:
//   - URL fetches refuse non-http(s) schemes and private, loopback, or
//     link-local hosts (SSRF guard below).
//   - Evaluations are rate limited per visitor and capped per day
//     (the hosted demo calls the battery on visitor input).
//   - Fetched text is treated as untrusted data: it is only ever read
//     by the deterministic battery and the proposal extractor, never
//     executed or followed as instructions.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";

import { loadEnv, paypalConfig, paypalConfigured } from "./env.ts";
import { createPayPalClient, LocalStubPayPalClient } from "./paypal.ts";
import { DeskError, DeskService, DEFAULT_DESK_CONFIG, freeView, fullView } from "./service.ts";
import { Store } from "./store.ts";
import { CASE_STUDIES } from "./samples.ts";
import type { EvaluationRecord, OrderRecord } from "./store.ts";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const cfg = paypalConfig();
const paypal = createPayPalClient(cfg);
const store = new Store(
  process.env.DESK_DATA_FILE || join(process.cwd(), "data", "store.json"),
);
const service = new DeskService(store, paypal, {
  ...DEFAULT_DESK_CONFIG,
  baseUrl: process.env.DESK_BASE_URL || `http://localhost:${PORT}`,
});

// ------------------------------------------------------------ guards

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (ipVersion === 6) {
    if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}

export function assertUrlAllowed(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DeskError("Only http and https posting URLs are fetched.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new DeskError(
      "That URL points at a private or internal address and will not be fetched.",
    );
  }
}

const rateBuckets = new Map<string, { count: number; windowStart: number }>();
const RATE_PER_MIN = Number(process.env.EVAL_RATE_PER_MIN || 10);
const DAILY_CAP = Number(process.env.DESK_DAILY_EVAL_CAP || 500);
let dailyCount = { day: "", count: 0 };

function assertEvaluationAllowed(ip: string): void {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) ?? { count: 0, windowStart: now };
  if (now - bucket.windowStart > 60_000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_PER_MIN) {
    throw new DeskError("Rate limit reached for evaluations; try again in a minute.", 429);
  }
  const day = new Date().toISOString().slice(0, 10);
  if (dailyCount.day !== day) dailyCount = { day, count: 0 };
  dailyCount.count += 1;
  if (dailyCount.count > DAILY_CAP) {
    throw new DeskError("The desk has reached its daily evaluation cap.", 429);
  }
}

// ------------------------------------------------------------ helpers

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  const stubBanner =
    paypal.kind === "local-stub"
      ? `<div class="stub">LOCAL STUB MODE — no PayPal credentials are configured, so checkout runs against a clearly labelled local stub. No real PayPal call is made and no money moves.</div>`
      : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Verdict Desk</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #f6f4ef; color: #1c1a17; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 28px; margin: 8px 0 4px; }
  .sub { color: #5c554b; margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid #e3ddd2; border-radius: 12px; padding: 20px; margin: 16px 0; }
  .verdict { font-size: 22px; font-weight: 700; }
  .verdict.GO { color: #177245; } .verdict.CAUTION { color: #b25e09; } .verdict.NO-GO { color: #b3261e; }
  .check { border-top: 1px solid #eee7da; padding: 10px 0; }
  .status { font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }
  .status.pass { color: #177245; } .status.caution { color: #b25e09; } .status.fail { color: #b3261e; } .status.unknown { color: #6b655c; }
  blockquote { margin: 6px 0 6px 12px; padding: 6px 12px; border-left: 3px solid #d8d0bf; background: #faf8f3; color: #3d382f; font-size: 14px; }
  textarea { width: 100%; min-height: 160px; font: inherit; padding: 10px; border: 1px solid #cfc7b8; border-radius: 8px; }
  input[type=text], input[type=url] { width: 100%; font: inherit; padding: 8px 10px; border: 1px solid #cfc7b8; border-radius: 8px; margin: 4px 0 10px; }
  button, .button { display: inline-block; background: #1c1a17; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; font: inherit; cursor: pointer; text-decoration: none; }
  button.secondary, .button.secondary { background: #fff; color: #1c1a17; border: 1px solid #1c1a17; }
  .stub { background: #fff3cd; border: 1px solid #e0c465; padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 14px; }
  .muted { color: #6b655c; font-size: 14px; }
  .err { background: #fdecea; border: 1px solid #e5a49e; padding: 12px 14px; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; } td, th { border-top: 1px solid #eee7da; padding: 6px 8px; text-align: left; vertical-align: top; }
</style></head>
<body><main>
<header><strong>Verdict Desk</strong> <span class="muted">— know before you work</span></header>
${stubBanner}
${body}
</main></body></html>`;
}

function verdictCardHtml(record: EvaluationRecord): string {
  const view = freeView(record);
  const checks = view.checks
    .map(
      (check) => `<div class="check">
        <span class="status ${check.status}">${esc(check.status)}</span>
        <strong>${esc(check.name)}</strong>
        <div>${esc(check.summary)}</div>
        ${check.evidence.map((e) => `<blockquote>${esc(e.quote)}<div class="muted">— ${esc(e.source)}</div></blockquote>`).join("")}
        ${check.moreEvidenceCount > 0 ? `<div class="muted">+ ${check.moreEvidenceCount} more quoted line(s) in the full evaluation</div>` : ""}
      </div>`,
    )
    .join("");
  const buyBlock = view.fullUnlocked
    ? `<p><a class="button" href="/desk/${record.id}/full">Open the full evaluation</a></p>`
    : `<div class="card">
        <strong>Full evaluation — $${esc(DEFAULT_DESK_CONFIG.fullPrice)} USD</strong>
        <p class="muted">Every quoted line for every check, the verified structured terms, the claim checklist, and the smallest edit set. Unlocked the moment the PayPal capture completes; refunded automatically if the full run fails after capture.</p>
        <div id="paypal-buttons"></div>
        <form method="post" action="/buy/full/${record.id}">
          <button type="submit">Buy the full verdict with PayPal</button>
        </form>
      </div>
      <div class="card">
        <strong>Poster recheck — $${esc(DEFAULT_DESK_CONFIG.recheckPrice)} USD</strong>
        <p class="muted">Fixed the posting? Paste the edited text and pay the smaller recheck; the desk re-runs every check and shows what moved.</p>
        <form method="post" action="/buy/recheck/${record.id}">
          <textarea name="editedText" placeholder="Paste the edited posting text"></textarea>
          <button type="submit" class="secondary">Buy a recheck with PayPal</button>
        </form>
      </div>`;
  const sdk =
    paypal.kind === "paypal-sandbox" && paypalConfigured()
      ? `<script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId ?? "")}&currency=USD"></script>
<script>
  if (window.paypal) {
    paypal.Buttons({
      createOrder: async () => {
        const res = await fetch("/api/orders/full", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluationId: "${record.id}" }) });
        const data = await res.json();
        if (!res.ok) { alert(data.error || "Could not create the order."); throw new Error(data.error || "create failed"); }
        window.__vdRecord = data.recordId;
        return data.paypalOrderId;
      },
      onApprove: () => { window.location = "/checkout/return?record=" + window.__vdRecord; }
    }).render("#paypal-buttons");
  }
</script>`
      : "";
  return page(
    record.title,
    `<h1>${esc(record.title)}</h1>
     <div class="card">
       <div class="verdict ${view.verdict}">${esc(view.verdict)}</div>
       <p>${esc(record.explanation)}</p>
       <ul>${view.verdictReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
       ${checks}
     </div>
     ${buyBlock}
     ${sdk}`,
  );
}

function fullHtml(record: EvaluationRecord): string {
  const view = fullView(record);
  const checks = view.checks
    .map(
      (check) => `<div class="check">
        <span class="status ${check.status}">${esc(check.status)}</span>
        <strong>${esc(check.name)}</strong>
        <div>${esc(check.summary)}</div>
        ${check.evidence.map((e) => `<blockquote>${esc(e.quote)}<div class="muted">— ${esc(e.source)}</div></blockquote>`).join("")}
      </div>`,
    )
    .join("");
  const terms = view.verifiedTerms
    .map(
      (t) =>
        `<tr><td>${esc(t.field)}</td><td>${esc(t.value)}</td><td>${esc(t.quote)}</td><td>${esc(t.backedByCheck)}</td></tr>`,
    )
    .join("");
  const dropped = view.droppedProposals
    .map(
      (t) =>
        `<tr><td>${esc(t.field)}</td><td>${esc(t.value)}</td><td>${esc(t.reason)}</td></tr>`,
    )
    .join("");
  const checklist = view.claimChecklist
    .map(
      (step) =>
        `<li><strong>${esc(step.label)}:</strong> ${esc(step.detail)}${step.evidence ? `<blockquote>${esc(step.evidence)}</blockquote>` : ""}</li>`,
    )
    .join("");
  const edits = view.smallestEditSet.map((e) => `<li>${esc(e)}</li>`).join("");
  return page(
    `Full evaluation — ${record.title}`,
    `<h1>Full evaluation</h1>
     <p class="sub">${esc(record.title)}</p>
     <div class="card"><div class="verdict ${view.verdict}">${esc(view.verdict)}</div>${checks}</div>
     <div class="card"><h3>Verified structured terms (proposed by the AI layer, verified by the battery)</h3>
       <table><tr><th>Field</th><th>Value</th><th>Quote</th><th>Backed by check</th></tr>${terms || '<tr><td colspan="4">No proposal survived verification.</td></tr>'}</table>
       ${dropped ? `<h4>Proposals the battery did not back</h4><table><tr><th>Field</th><th>Value</th><th>Why dropped</th></tr>${dropped}</table>` : ""}
     </div>
     <div class="card"><h3>Claim checklist</h3><ol>${checklist}</ol></div>
     <div class="card"><h3>Smallest edit set</h3><ol>${edits || "<li>No edits needed on the supplied text.</li>"}</ol></div>
     <p><a href="/desk/${record.id}">Back to the verdict card</a></p>`,
  );
}

function receiptHtml(orderRecordId: string): string {
  const receipt = service.receipt(orderRecordId);
  const rows = Object.entries(receipt)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join("");
  return page(
    "Receipt",
    `<h1>Receipt</h1><div class="card"><table>${rows}</table></div>
     <p class="muted">Payment rail: ${esc(receipt.paypalKind)}. Capture confirmation by webhook: ${receipt.captureConfirmedByWebhook ? "yes" : "not yet received"}.</p>`,
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ip = req.socket.remoteAddress ?? "unknown";
  try {
    // ------------------------------------------------ home / evaluate
    if (req.method === "GET" && url.pathname === "/") {
      const cases = CASE_STUDIES.map(
        (c) =>
          `<form method="post" action="/evaluate" style="display:inline">
             <input type="hidden" name="sampleId" value="${esc(c.id)}">
             <button type="submit" class="secondary">${esc(c.id)}</button>
           </form>`,
      ).join(" ");
      const list = store
        .listEvaluations()
        .map(
          (e) =>
            `<li><a href="/desk/${e.id}">${esc(e.title)}</a> — <span class="status ${e.result.verdict === "GO" ? "pass" : e.result.verdict === "CAUTION" ? "caution" : "fail"}">${esc(e.result.verdict)}</span></li>`,
        )
        .join("");
      sendHtml(
        res,
        200,
        page(
          "Verdict Desk",
          `<h1>Before you work, know if the money is real</h1>
           <p class="sub">Paste a work posting, gig listing, or bounty brief. The desk reads it, quotes the exact lines that prove or fail each point, and gives a verdict: GO, CAUTION, or NO-GO. The first verdict is free; the full evaluation is bought through PayPal.</p>
           <div class="card">
             <form method="post" action="/evaluate">
               <label>Posting URL (public pages only)</label>
               <input type="url" name="sourceUrl" placeholder="https://example.com/posting">
               <label>Or paste the posting text</label>
               <textarea name="text" placeholder="Paste the posting text here"></textarea>
               <label>Related sponsor page URL (optional, for the fill check)</label>
               <input type="url" name="relatedUrl" placeholder="https://example.com/results">
               <button type="submit">Run the free verdict</button>
             </form>
           </div>
           <div class="card"><strong>Case studies</strong>
             <p class="muted">Reconstructed from real cases with names changed, plus one labelled illustrative sample. Load one and run it:</p>
             ${cases}
           </div>
           ${list ? `<div class="card"><strong>Evaluations on this desk</strong><ul>${list}</ul></div>` : ""}`,
        ),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/evaluate") {
      assertEvaluationAllowed(ip);
      const body = await readJson(req);
      let text = typeof body.text === "string" ? body.text : "";
      let relatedText: string | undefined;
      if (typeof body.sampleId === "string") {
        const sample = CASE_STUDIES.find((c) => c.id === body.sampleId);
        if (sample) {
          text = sample.text;
          relatedText = sample.relatedText;
        }
      }
      const sourceUrl =
        typeof body.sourceUrl === "string" && body.sourceUrl
          ? body.sourceUrl
          : undefined;
      const relatedUrl =
        typeof body.relatedUrl === "string" && body.relatedUrl
          ? body.relatedUrl
          : undefined;
      if (sourceUrl) assertUrlAllowed(sourceUrl);
      if (relatedUrl) assertUrlAllowed(relatedUrl);
      const record = await service.evaluateFree({
        text: text || undefined,
        sourceUrl,
        relatedUrl,
        relatedText,
      });
      redirect(res, `/desk/${record.id}`);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/evaluate") {
      assertEvaluationAllowed(ip);
      const body = await readJson(req);
      const sourceUrl =
        typeof body.sourceUrl === "string" && body.sourceUrl
          ? body.sourceUrl
          : undefined;
      const relatedUrl =
        typeof body.relatedUrl === "string" && body.relatedUrl
          ? body.relatedUrl
          : undefined;
      if (sourceUrl) assertUrlAllowed(sourceUrl);
      if (relatedUrl) assertUrlAllowed(relatedUrl);
      const record = await service.evaluateFree({
        text: typeof body.text === "string" ? body.text : undefined,
        sourceUrl,
        relatedUrl,
        relatedText:
          typeof body.relatedText === "string" ? body.relatedText : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
      });
      sendJson(res, 200, freeView(record));
      return;
    }

    // ------------------------------------------------ verdict pages
    const deskMatch = url.pathname.match(/^\/desk\/([\w-]+)$/);
    if (req.method === "GET" && deskMatch) {
      const record = store.getEvaluation(deskMatch[1]);
      if (!record) {
        sendHtml(res, 404, page("Not found", `<div class="err">Evaluation not found.</div>`));
        return;
      }
      sendHtml(res, 200, verdictCardHtml(record));
      return;
    }
    const fullMatch = url.pathname.match(/^\/desk\/([\w-]+)\/full$/);
    if (req.method === "GET" && fullMatch) {
      const record = store.getEvaluation(fullMatch[1]);
      if (!record) {
        sendHtml(res, 404, page("Not found", `<div class="err">Evaluation not found.</div>`));
        return;
      }
      if (!record.fullUnlockedAt) {
        sendHtml(
          res,
          403,
          page(
            "Locked",
            `<div class="err">The full evaluation unlocks when a PayPal capture completes for this verdict. <a href="/desk/${record.id}">Back to the verdict card</a></div>`,
          ),
        );
        return;
      }
      sendHtml(res, 200, fullHtml(record));
      return;
    }
    const fullJsonMatch = url.pathname.match(/^\/api\/evaluations\/([\w-]+)\/full$/);
    if (req.method === "GET" && fullJsonMatch) {
      const record = store.getEvaluation(fullJsonMatch[1]);
      if (!record) return sendJson(res, 404, { error: "Evaluation not found." });
      if (!record.fullUnlockedAt) {
        return sendJson(res, 403, {
          error: "The full evaluation is locked until a PayPal capture completes.",
        });
      }
      sendJson(res, 200, fullView(record));
      return;
    }
    const recheckMatch = url.pathname.match(/^\/desk\/([\w-]+)\/recheck\/([\w-]+)$/);
    if (req.method === "GET" && recheckMatch) {
      const record = store.getEvaluation(recheckMatch[1]);
      const recheck = record?.rechecks.find((r) => r.id === recheckMatch[2]);
      if (!record || !recheck || !recheck.result) {
        sendHtml(res, 404, page("Not found", `<div class="err">Recheck not found.</div>`));
        return;
      }
      const before = new Map(record.result.checks.map((c) => [c.id, c.status]));
      const movement = recheck.result.checks
        .map((check) => {
          const was = before.get(check.id) ?? "—";
          return `<tr><td>${esc(check.name)}</td><td>${esc(was)}</td><td>${esc(check.status)}</td><td>${esc(check.summary)}</td></tr>`;
        })
        .join("");
      sendHtml(
        res,
        200,
        page(
          "Recheck result",
          `<h1>Recheck: ${esc(record.title)}</h1>
           <div class="card">
             <p>Verdict moved: <strong>${esc(recheck.previousVerdict)}</strong> → <span class="verdict ${recheck.result.verdict}">${esc(recheck.result.verdict)}</span></p>
             <p>${esc(recheck.explanation ?? "")}</p>
             <table><tr><th>Check</th><th>Was</th><th>Now</th><th>Summary</th></tr>${movement}</table>
           </div>
           <p><a href="/desk/${record.id}">Back to the verdict card</a></p>`,
        ),
      );
      return;
    }

    // ------------------------------------------------ buying
    const buyFullMatch = url.pathname.match(/^\/buy\/full\/([\w-]+)$/);
    if (req.method === "POST" && buyFullMatch) {
      const order = await service.createFullOrder(buyFullMatch[1]);
      if (!order.approveLink) throw new DeskError("PayPal returned no approve link.", 502);
      redirect(res, order.approveLink);
      return;
    }
    const buyRecheckMatch = url.pathname.match(/^\/buy\/recheck\/([\w-]+)$/);
    if (req.method === "POST" && buyRecheckMatch) {
      const body = await readJson(req);
      const { order } = await service.createRecheckOrder({
        evaluationId: buyRecheckMatch[1],
        editedText: typeof body.editedText === "string" ? body.editedText : "",
      });
      if (!order.approveLink) throw new DeskError("PayPal returned no approve link.", 502);
      redirect(res, order.approveLink);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/orders/full") {
      const body = await readJson(req);
      const order = await service.createFullOrder(String(body.evaluationId ?? ""));
      sendJson(res, 200, {
        recordId: order.id,
        paypalOrderId: order.paypalOrderId,
        approveLink: order.approveLink,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/orders/recheck") {
      const body = await readJson(req);
      const { order } = await service.createRecheckOrder({
        evaluationId: String(body.evaluationId ?? ""),
        editedText: typeof body.editedText === "string" ? body.editedText : "",
      });
      sendJson(res, 200, {
        recordId: order.id,
        paypalOrderId: order.paypalOrderId,
        approveLink: order.approveLink,
      });
      return;
    }

    // ------------------------------------------------ checkout return
    if (req.method === "GET" && url.pathname === "/checkout/return") {
      const recordId = url.searchParams.get("record") ?? "";
      const { order, evaluation, recheck } = await service.captureAndUnlock(recordId);
      if (order.product === "recheck" && recheck) {
        redirect(res, `/desk/${evaluation.id}/recheck/${recheck.id}`);
      } else {
        redirect(res, `/receipt/${order.id}`);
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/checkout/cancel") {
      sendHtml(
        res,
        200,
        page(
          "Checkout cancelled",
          `<div class="card">The PayPal checkout was cancelled. Nothing was captured and nothing was unlocked. <a href="/">Back to the desk</a></div>`,
        ),
      );
      return;
    }
    const receiptMatch = url.pathname.match(/^\/receipt\/([\w-]+)$/);
    if (req.method === "GET" && receiptMatch) {
      const order = store.getOrder(receiptMatch[1]);
      if (!order) {
        sendHtml(res, 404, page("Not found", `<div class="err">Receipt not found.</div>`));
        return;
      }
      const extra =
        order.product === "full-verdict"
          ? `<p><a class="button" href="/desk/${order.evaluationId}/full">Open the full evaluation</a></p>`
          : "";
      sendHtml(res, 200, receiptHtml(order.id) + extra);
      return;
    }

    // ------------------------------------------------ stub checkout
    const stubMatch = url.pathname.match(/^\/stub\/checkout\/(.+)$/);
    if (req.method === "GET" && stubMatch) {
      if (!(paypal instanceof LocalStubPayPalClient)) {
        sendHtml(res, 404, page("Not found", `<div class="err">Stub checkout is only available in local stub mode.</div>`));
        return;
      }
      const order: OrderRecord | null = store.getOrderByPayPalId(stubMatch[1]);
      if (!order) {
        sendHtml(res, 404, page("Not found", `<div class="err">Stub order not found.</div>`));
        return;
      }
      sendHtml(
        res,
        200,
        page(
          "LOCAL STUB checkout",
          `<div class="stub"><strong>LOCAL STUB — this is not PayPal.</strong> No credentials are configured, so this page stands in for the PayPal sandbox approval step during local development. Approving here changes only local state; no real PayPal call is made and no money moves.</div>
           <div class="card">
             <p>Stub order <strong>${esc(order.paypalOrderId)}</strong> — ${esc(order.value)} ${esc(order.currencyCode)} for ${esc(order.product)}.</p>
             <form method="post" action="/stub/approve/${esc(order.paypalOrderId)}">
               <button type="submit">Approve (stub)</button>
             </form>
           </div>`,
        ),
      );
      return;
    }
    const stubApproveMatch = url.pathname.match(/^\/stub\/approve\/(.+)$/);
    if (req.method === "POST" && stubApproveMatch) {
      if (!(paypal instanceof LocalStubPayPalClient)) {
        sendHtml(res, 404, page("Not found", `<div class="err">Stub checkout is only available in local stub mode.</div>`));
        return;
      }
      paypal.approveStubOrder(stubApproveMatch[1]);
      const order = store.getOrderByPayPalId(stubApproveMatch[1]);
      if (!order) throw new DeskError("Stub order not found.", 404);
      redirect(res, `/checkout/return?record=${order.id}`);
      return;
    }

    // ------------------------------------------------ webhook
    if (req.method === "POST" && url.pathname === "/api/webhooks/paypal") {
      const raw = await readBody(req);
      let event: { event_type?: string; resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
      try {
        event = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON." });
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      const verified = await paypal.verifyWebhookSignature({ headers, event });
      if (!verified) {
        return sendJson(res, 401, { error: "Webhook signature verification failed." });
      }
      const result = service.handleWebhookEvent(event);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, paypalKind: paypal.kind });
      return;
    }

    sendHtml(res, 404, page("Not found", `<div class="err">Not found. <a href="/">Back to the desk</a></div>`));
  } catch (error) {
    if (error instanceof DeskError) {
      if (req.url?.startsWith("/api/") || req.url?.startsWith("/checkout/")) {
        sendJson(res, error.statusCode, { error: error.message });
      } else {
        sendHtml(
          res,
          error.statusCode,
          page("Something needs attention", `<div class="err">${esc(error.message)}</div><p><a href="/">Back to the desk</a></p>`),
        );
      }
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Internal error." });
  }
});

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  server.listen(PORT, () => {
    console.log(`Verdict Desk listening on http://localhost:${PORT}`);
    console.log(`Payment rail: ${paypal.kind}`);
    if (paypal.kind === "local-stub") {
      console.log(
        "LOCAL STUB MODE: no PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in the environment. Checkout is simulated locally and labelled as a stub everywhere.",
      );
    }
  });
}

export { server };
