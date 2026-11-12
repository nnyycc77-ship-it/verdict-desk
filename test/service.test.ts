// The desk service: the tier split, the capture-gated unlock, the
// paid recheck, and the automatic refund when a paid evaluation
// fails after capture. Runs on the local stub PayPal client, which
// is labelled a stub in every field it touches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { DeskError, DeskService, freeView, fullView } from "../src/service.ts";
import { LocalStubPayPalClient } from "../src/paypal.ts";
import { Store } from "../src/store.ts";
import { OFFERS_POSTING } from "../src/samples.ts";

function makeService() {
  const stub = new LocalStubPayPalClient();
  const store = new Store(null);
  const service = new DeskService(store, stub);
  return { stub, store, service };
}

test("the free view never carries the paid payload", async () => {
  const { service } = makeService();
  const record = await service.evaluateFree({ text: OFFERS_POSTING });
  const view = freeView(record) as unknown as Record<string, unknown>;
  assert.equal(view.verdict, "CAUTION");
  assert.equal(view.fullUnlocked, false);
  assert.ok(!("claimChecklist" in view));
  assert.ok(!("verifiedTerms" in view));
  assert.ok(!("smallestEditSet" in view));
  const checks = view.checks as Array<{ evidence: unknown[]; moreEvidenceCount: number }>;
  for (const check of checks) {
    assert.ok(check.evidence.length <= 1, "free view shows at most one quote per check");
  }
});

test("the full evaluation stays locked until a capture completes", async () => {
  const { stub, service } = makeService();
  const record = await service.evaluateFree({ text: OFFERS_POSTING });
  const order = await service.createFullOrder(record.id);
  assert.equal(order.status, "created");
  // Not approved yet: capture must refuse.
  await assert.rejects(
    () => service.captureAndUnlock(order.id),
    /must be APPROVED/,
  );
  stub.approveStubOrder(order.paypalOrderId);
  const { order: captured, evaluation } = await service.captureAndUnlock(order.id);
  assert.equal(captured.status, "captured");
  assert.match(captured.captureId ?? "", /^STUB-CAPTURE-/);
  assert.ok(evaluation.fullUnlockedAt);
  const view = fullView(evaluation);
  assert.ok(view.claimChecklist.length >= 4);
  assert.ok(view.verifiedTerms.length >= 3);
  assert.ok(view.smallestEditSet.length >= 1);
  // Capturing again is a no-op read, not a second charge.
  const again = await service.captureAndUnlock(order.id);
  assert.equal(again.order.captureId, captured.captureId);
});

test("a paid recheck re-runs the battery on the edited text and shows the movement", async () => {
  const { stub, service } = makeService();
  const record = await service.evaluateFree({ text: OFFERS_POSTING });
  const edited = OFFERS_POSTING.replace(
    "We may choose not to award if no submission meets the bar. ",
    "",
  );
  const { order, recheck } = await service.createRecheckOrder({
    evaluationId: record.id,
    editedText: edited,
  });
  stub.approveStubOrder(order.paypalOrderId);
  const { recheck: done } = await service.captureAndUnlock(order.id);
  assert.equal(done?.id, recheck.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.previousVerdict, "CAUTION");
  const discretion = done?.result?.checks.find((c) => c.id === "discretion");
  assert.equal(discretion?.status, "pass");
});

test("a paid evaluation that fails after capture is refunded automatically", async () => {
  // Serve the posting from a local page, evaluate it, then take the
  // page away: the fresh full run after capture cannot fetch it, so
  // the paid evaluation fails and the refund rule fires.
  const page = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><p>${OFFERS_POSTING.replace(/\n/g, " ")}</p></body></html>`);
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const port = (page.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/posting`;
  try {
    const { stub, store, service } = makeService();
    const record = await service.evaluateFree({ sourceUrl: url });
    assert.equal(record.result.verdict, "CAUTION");
    const order = await service.createFullOrder(record.id);
    stub.approveStubOrder(order.paypalOrderId);
    await new Promise<void>((resolve) => page.close(() => resolve()));
    await assert.rejects(
      () => service.captureAndUnlock(order.id),
      (error: unknown) => {
        assert.ok(error instanceof DeskError);
        assert.match(error.message, /refunded in full/);
        return true;
      },
    );
    const stored = store.getOrder(order.id);
    assert.equal(stored?.status, "refunded");
    assert.ok(stored?.refundId);
    assert.equal(stub.refunds.length, 1);
    const evaluation = store.getEvaluation(record.id);
    assert.equal(evaluation?.fullUnlockedAt, null);
  } finally {
    page.close();
  }
});

test("webhook capture confirmation marks the order confirmed", async () => {
  const { stub, service, store } = makeService();
  const record = await service.evaluateFree({ text: OFFERS_POSTING });
  const order = await service.createFullOrder(record.id);
  stub.approveStubOrder(order.paypalOrderId);
  await service.captureAndUnlock(order.id);
  const result = service.handleWebhookEvent({
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "STUB-CAPTURE-EVENT",
      supplementary_data: { related_ids: { order_id: order.paypalOrderId } },
    },
  });
  assert.equal(result.handled, true);
  assert.equal(store.getOrder(order.id)?.captureConfirmedByWebhook, true);
  const receipt = service.receipt(order.id);
  assert.equal(receipt.captureConfirmedByWebhook, true);
  assert.equal(receipt.paypalKind, "local-stub");
});
