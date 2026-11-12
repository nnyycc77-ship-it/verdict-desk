// The live PayPal sandbox round trip, as a single command:
//
//   npm run round-trip
//
// Prereqs: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for a sandbox
// app in the environment (or in build/.env), PAYPAL_ENV=sandbox.
// The script never prints the credentials.
//
// What it does:
//   1. Boots the desk service in-process against a throwaway store.
//   2. Runs a free evaluation on the "offers" case study.
//   3. Creates a real sandbox order for the full evaluation and
//      prints the PayPal approve link.
//   4. Polls the order until you approve it in the sandbox (open the
//      link, sign in with a sandbox personal test account, approve),
//      up to ROUND_TRIP_TIMEOUT_MIN minutes (default 15).
//   5. Captures the order, verifies the capture status is COMPLETED,
//      and verifies the full evaluation is unlocked.
//   6. Prints a PASS summary with the order id and capture id.
//
// In stub mode (no credentials) it refuses to run: a stub pass would
// prove nothing about PayPal. Use npm test for the credential-free
// flow tests.

import { loadEnv, paypalConfig } from "../src/env.ts";
import { createPayPalClient, getApproveLink } from "../src/paypal.ts";
import { DeskService, DEFAULT_DESK_CONFIG } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { OFFERS_POSTING } from "../src/samples.ts";

loadEnv();

const cfg = paypalConfig();
if (!cfg.clientId || !cfg.clientSecret) {
  console.error(
    "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. The live round trip needs the sandbox app credentials in the server environment (or in build/.env). See BUILD-REPORT.md.",
  );
  process.exit(2);
}

const paypal = createPayPalClient(cfg);
const store = new Store(null);
const baseUrl = process.env.DESK_BASE_URL || "http://localhost:8787";
const service = new DeskService(store, paypal, {
  ...DEFAULT_DESK_CONFIG,
  baseUrl,
});

const timeoutMin = Number(process.env.ROUND_TRIP_TIMEOUT_MIN || 15);

async function main(): Promise<void> {
  console.log("1. Free evaluation on the offers case study…");
  const evaluation = await service.evaluateFree({ text: OFFERS_POSTING });
  console.log(`   verdict: ${evaluation.result.verdict}`);

  console.log("2. Creating a sandbox order for the full evaluation…");
  const order = await service.createFullOrder(evaluation.id);
  const link = getApproveLink(
    await paypal.getOrder(order.paypalOrderId),
  ) ?? order.approveLink;
  console.log(`   order: ${order.paypalOrderId} (${order.value} ${order.currencyCode})`);
  console.log(`   approve link: ${link}`);
  console.log(
    "   Open the link, sign in with a PayPal sandbox personal test account, and approve the payment.",
  );

  console.log(`3. Waiting for approval (up to ${timeoutMin} minutes)…`);
  const deadline = Date.now() + timeoutMin * 60_000;
  let status = "";
  while (Date.now() < deadline) {
    const remote = await paypal.getOrder(order.paypalOrderId);
    status = remote.status;
    if (status === "APPROVED" || status === "COMPLETED") break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (status !== "APPROVED" && status !== "COMPLETED") {
    console.error(`   Order is still ${status}; approval did not land in time. Nothing was captured.`);
    process.exit(1);
  }

  console.log("4. Capturing and verifying the unlock…");
  const { order: capturedOrder, evaluation: unlocked } =
    await service.captureAndUnlock(order.id);
  const fresh = store.getEvaluation(evaluation.id);
  if (!fresh?.fullUnlockedAt || !capturedOrder.captureId) {
    console.error("   Capture finished but the unlock did not verify.");
    process.exit(1);
  }
  console.log(
    `PASS — order ${capturedOrder.paypalOrderId}, capture ${capturedOrder.captureId}, full evaluation unlocked at ${fresh.fullUnlockedAt}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
