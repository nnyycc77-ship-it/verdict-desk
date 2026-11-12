// The PayPal client, against a mock fetch that records requests.
// No real PayPal call happens in this suite.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LocalStubPayPalClient,
  PayPalSandboxClient,
  getApproveLink,
  getCapture,
} from "../src/paypal.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockPayPalFetch(calls: RecordedCall[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    if (String(url).endsWith("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (String(url).endsWith("/v2/checkout/orders") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "MOCKORDER1",
          status: "CREATED",
          links: [
            { href: "https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER1", rel: "approve", method: "GET" },
          ],
          purchase_units: [{ reference_id: "ref-1", amount: { value: "5.00", currency_code: "USD" } }],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (String(url).includes("/capture")) {
      return new Response(
        JSON.stringify({
          id: "MOCKORDER1",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: "ref-1",
              payments: {
                captures: [
                  { id: "MOCKCAPTURE1", status: "COMPLETED", amount: { value: "5.00", currency_code: "USD" } },
                ],
              },
            },
          ],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (String(url).includes("/refund")) {
      return new Response(JSON.stringify({ id: "MOCKREFUND1", status: "COMPLETED" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).endsWith("/v2/checkout/orders/MOCKORDER1")) {
      return new Response(
        JSON.stringify({ id: "MOCKORDER1", status: "APPROVED", links: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const CFG = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  env: "sandbox",
  webhookId: null as string | null,
};

test("the sandbox client creates, reads, captures, and refunds on the sandbox host only", async () => {
  const calls: RecordedCall[] = [];
  const client = new PayPalSandboxClient(CFG, mockPayPalFetch(calls));
  const order = await client.createOrder({
    value: "5.00",
    currencyCode: "USD",
    referenceId: "ref-1",
    description: "Full evaluation",
    returnUrl: "http://localhost:8787/checkout/return?record=ref-1",
    cancelUrl: "http://localhost:8787/checkout/cancel",
  });
  assert.equal(order.id, "MOCKORDER1");
  assert.match(getApproveLink(order) ?? "", /sandbox\.paypal\.com/);
  const createPayload = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))?.body ?? "{}");
  assert.equal(createPayload.intent, "CAPTURE");
  assert.equal(createPayload.purchase_units[0].amount.value, "5.00");
  assert.equal(
    createPayload.payment_source.paypal.experience_context.return_url,
    "http://localhost:8787/checkout/return?record=ref-1",
  );
  const read = await client.getOrder("MOCKORDER1");
  assert.equal(read.status, "APPROVED");
  const captured = await client.captureOrder("MOCKORDER1");
  assert.equal(captured.status, "COMPLETED");
  assert.equal(getCapture(captured)?.id, "MOCKCAPTURE1");
  const refund = await client.refundCapture("MOCKCAPTURE1", "5.00", "USD");
  assert.equal(refund.status, "COMPLETED");
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api-m\.sandbox\.paypal\.com\//);
  }
  const tokenCall = calls.find((c) => c.url.endsWith("/v1/oauth2/token"));
  assert.ok(tokenCall);
  assert.match(tokenCall.headers.authorization, /^Basic /);
});

test("the client refuses a non-sandbox environment", () => {
  assert.throws(
    () => new PayPalSandboxClient({ ...CFG, env: "live" }, mockPayPalFetch([])),
    /sandbox only/,
  );
});

test("webhook verification fails closed without a webhook id", async () => {
  const client = new PayPalSandboxClient(CFG, mockPayPalFetch([]));
  const ok = await client.verifyWebhookSignature({ headers: {}, event: {} });
  assert.equal(ok, false);
});

test("a token failure surfaces as an error, never as a fake success", async () => {
  const failingFetch = (async () =>
    new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const client = new PayPalSandboxClient(CFG, failingFetch);
  await assert.rejects(
    () =>
      client.createOrder({
        value: "5.00",
        currencyCode: "USD",
        referenceId: "ref-1",
        description: "x",
        returnUrl: "http://localhost/return",
        cancelUrl: "http://localhost/cancel",
      }),
    /token request failed with HTTP 401/,
  );
});

test("the stub client walks create, approve, capture and records refunds", async () => {
  const stub = new LocalStubPayPalClient();
  const order = await stub.createOrder({
    value: "5.00",
    currencyCode: "USD",
    referenceId: "ref-1",
    description: "Full evaluation",
    returnUrl: "http://localhost/checkout/return",
    cancelUrl: "http://localhost/checkout/cancel",
  });
  assert.match(order.id, /^STUB-/);
  assert.equal(order.status, "CREATED");
  await assert.rejects(() => stub.captureOrder(order.id), /must be APPROVED/);
  stub.approveStubOrder(order.id);
  const captured = await stub.captureOrder(order.id);
  assert.equal(captured.status, "COMPLETED");
  assert.match(getCapture(captured)?.id ?? "", /^STUB-CAPTURE-/);
  const refund = await stub.refundCapture(getCapture(captured)?.id ?? "", "5.00", "USD");
  assert.equal(refund.status, "COMPLETED");
  assert.equal(stub.refunds.length, 1);
});
