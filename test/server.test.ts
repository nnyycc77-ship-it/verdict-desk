// End-to-end over HTTP, in local stub mode (no credentials in the
// test environment): the home page loads, a free evaluation runs,
// the full view is locked, the stub checkout unlocks it, and the
// SSRF guard refuses a private address.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.DESK_DATA_FILE = join(
  mkdtempSync(join(tmpdir(), "verdict-desk-test-")),
  "store.json",
);
// Pin the PayPal credentials to empty, do not delete them. The
// server module calls loadEnv() at import time, and loadEnv fills
// any UNDEFINED variable from the operator's local build/.env — so
// deleting the variables here silently resurrects the real sandbox
// credentials from .env, and the server under test boots on the real
// PayPal rail instead of the stub (the failure this fixes: no stub
// banner on the home page, and the webhook route answering 401 from
// the real client instead of 200). An explicitly empty value is
// defined, so loadEnv leaves it alone, and paypalConfig() treats an
// empty value as unconfigured, which selects the local stub. The
// pins also override any credentials exported in the shell that
// launched the test run, so the suite is hermetic either way.
process.env.PAYPAL_CLIENT_ID = "";
process.env.PAYPAL_CLIENT_SECRET = "";
process.env.PAYPAL_WEBHOOK_ID = "";

const { server } = await import("../src/server.ts");
const { OFFERS_POSTING } = await import("../src/samples.ts");

let base = "";

before(async () => {
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, "127.0.0.1", resolve),
  );
  const port = ((server as Server).address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
});

test("the whole stub flow: evaluate, locked full view, stub checkout, unlock", async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Verdict Desk/);
  assert.match(homeHtml, /LOCAL STUB MODE/);

  const evaluated = await fetch(`${base}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: OFFERS_POSTING }),
  });
  assert.equal(evaluated.status, 200);
  const free = (await evaluated.json()) as {
    id: string;
    verdict: string;
    claimChecklist?: unknown;
  };
  assert.equal(free.verdict, "CAUTION");
  assert.equal(free.claimChecklist, undefined);

  const locked = await fetch(`${base}/api/evaluations/${free.id}/full`);
  assert.equal(locked.status, 403);

  const orderRes = await fetch(`${base}/api/orders/full`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evaluationId: free.id }),
  });
  assert.equal(orderRes.status, 200);
  const order = (await orderRes.json()) as {
    recordId: string;
    paypalOrderId: string;
    approveLink: string;
  };
  assert.match(order.paypalOrderId, /^STUB-/);
  assert.match(order.approveLink, /^\/stub\/checkout\//);

  const stubPage = await fetch(`${base}${order.approveLink}`);
  assert.equal(stubPage.status, 200);
  assert.match(await stubPage.text(), /LOCAL STUB — this is not PayPal/);

  const approved = await fetch(`${base}/stub/approve/${order.paypalOrderId}`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approved.status, 302);
  const returnPath = approved.headers.get("location") ?? "";
  assert.match(returnPath, /\/checkout\/return\?record=/);

  const returned = await fetch(`${base}${returnPath}`, { redirect: "manual" });
  assert.equal(returned.status, 302);
  assert.match(returned.headers.get("location") ?? "", /\/receipt\//);

  const unlocked = await fetch(`${base}/api/evaluations/${free.id}/full`);
  assert.equal(unlocked.status, 200);
  const full = (await unlocked.json()) as {
    claimChecklist: unknown[];
    verifiedTerms: unknown[];
    smallestEditSet: unknown[];
  };
  assert.ok(full.claimChecklist.length >= 4);
  assert.ok(full.verifiedTerms.length >= 3);
  assert.ok(full.smallestEditSet.length >= 1);

  const receipt = await fetch(
    `${base}${returned.headers.get("location")}`,
  );
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /Receipt/);
});

test("the webhook route accepts a stub capture confirmation", async () => {
  const evaluated = await fetch(`${base}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: OFFERS_POSTING }),
  });
  const free = (await evaluated.json()) as { id: string };
  const orderRes = await fetch(`${base}/api/orders/full`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evaluationId: free.id }),
  });
  const order = (await orderRes.json()) as { paypalOrderId: string };
  const webhook = await fetch(`${base}/api/webhooks/paypal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "STUB-CAPTURE-WH",
        supplementary_data: {
          related_ids: { order_id: order.paypalOrderId },
        },
      },
    }),
  });
  assert.equal(webhook.status, 200);
  const result = (await webhook.json()) as { handled: boolean };
  assert.equal(result.handled, true);
});

test("the SSRF guard refuses private and loopback posting URLs", async () => {
  const refused = await fetch(`${base}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: "http://127.0.0.1:9/posting" }),
  });
  assert.equal(refused.status, 400);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /private or internal/);
});
