// PayPal Orders API client for the sandbox, plus a local stub that
// implements the same interface for credential-free development.
//
// The real client talks only to the PayPal sandbox host. This entry
// is built and judged on the free sandbox (see RULES.md), so the
// client refuses any environment other than "sandbox" rather than
// silently pointing at live money.
//
// The stub exists so the full local flow — create, approve, capture,
// unlock, refund — can be exercised and tested with no credentials.
// It is labelled a stub in every surface it touches: order ids start
// with STUB-, the checkout page it serves says LOCAL STUB in its
// title and body, and the server prints a stub banner while it is
// active. Nothing in the stub performs or imitates a real PayPal
// call; approval is a button on a local page, and the "capture" is a
// state change in the local store.

export interface PayPalOrderLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  links: PayPalOrderLink[];
  purchaseUnits: Array<{
    referenceId?: string;
    amount?: { value: string; currencyCode: string };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: { value: string; currencyCode: string };
      }>;
      refunds?: Array<{ id: string; status: string }>;
    };
  }>;
  raw: unknown;
}

export interface CreateOrderArgs {
  value: string;
  currencyCode: string;
  referenceId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PayPalClient {
  readonly kind: "paypal-sandbox" | "local-stub";
  createOrder(args: CreateOrderArgs): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string): Promise<PayPalOrder>;
  refundCapture(captureId: string, value: string, currencyCode: string): Promise<{ id: string; status: string }>;
  verifyWebhookSignature(args: {
    headers: Record<string, string | undefined>;
    event: unknown;
  }): Promise<boolean>;
}

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

function approveLink(order: PayPalOrder): string | null {
  // The live Orders v2 API names this link "payer-action"; older
  // responses and the local stub use "approve". Accept both.
  return (
    order.links.find((link) => link.rel === "payer-action")?.href ??
    order.links.find((link) => link.rel === "approve")?.href ??
    null
  );
}

export function getApproveLink(order: PayPalOrder): string | null {
  return approveLink(order);
}

export function getCapture(order: PayPalOrder): { id: string; status: string } | null {
  for (const unit of order.purchaseUnits) {
    const captures = unit.payments?.captures ?? [];
    if (captures.length > 0) return captures[0];
  }
  return null;
}

interface RawOrder {
  id: string;
  status: string;
  links?: PayPalOrderLink[];
  purchase_units?: Array<{
    reference_id?: string;
    amount?: { value: string; currency_code: string };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: { value: string; currency_code: string };
      }>;
      refunds?: Array<{ id: string; status: string }>;
    };
  }>;
}

function mapOrder(raw: RawOrder): PayPalOrder {
  return {
    id: raw.id,
    status: raw.status,
    links: raw.links ?? [],
    purchaseUnits: (raw.purchase_units ?? []).map((unit) => ({
      referenceId: unit.reference_id,
      amount: unit.amount
        ? { value: unit.amount.value, currencyCode: unit.amount.currency_code }
        : undefined,
      payments: unit.payments
        ? {
            captures: (unit.payments.captures ?? []).map((capture) => ({
              id: capture.id,
              status: capture.status,
              amount: capture.amount
                ? {
                    value: capture.amount.value,
                    currencyCode: capture.amount.currency_code,
                  }
                : undefined,
            })),
            refunds: unit.payments.refunds,
          }
        : undefined,
    })),
    raw,
  };
}

export class PayPalSandboxClient implements PayPalClient {
  readonly kind = "paypal-sandbox" as const;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private cfg: { clientId: string; clientSecret: string; env: string; webhookId: string | null };
  private fetchFn: typeof fetch;

  constructor(
    cfg: { clientId: string; clientSecret: string; env: string; webhookId: string | null },
    fetchFn: typeof fetch = fetch,
  ) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
    if (cfg.env !== "sandbox") {
      throw new Error(
        `This build runs against the PayPal sandbox only; PAYPAL_ENV is "${cfg.env}". Set PAYPAL_ENV=sandbox.`,
      );
    }
  }

  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }
    const basic = Buffer.from(
      `${this.cfg.clientId}:${this.cfg.clientSecret}`,
    ).toString("base64");
    const response = await this.fetchFn(`${SANDBOX_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      throw new Error(
        `PayPal sandbox token request failed with HTTP ${response.status}. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the server environment.`,
      );
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.accessToken();
    const response = await this.fetchFn(`${SANDBOX_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `PayPal sandbox request ${path} failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }
    if (response.status === 204) return {};
    return response.json();
  }

  async createOrder(args: CreateOrderArgs): Promise<PayPalOrder> {
    const raw = (await this.request("/v2/checkout/orders", {
      method: "POST",
      headers: { "paypal-request-id": `vd-${args.referenceId}` },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: args.referenceId,
            description: args.description,
            amount: {
              currency_code: args.currencyCode,
              value: args.value,
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: args.returnUrl,
              cancel_url: args.cancelUrl,
              user_action: "PAY_NOW",
            },
          },
        },
      }),
    })) as RawOrder;
    return mapOrder(raw);
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    const raw = (await this.request(`/v2/checkout/orders/${orderId}`, {
      method: "GET",
    })) as RawOrder;
    return mapOrder(raw);
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const raw = (await this.request(
      `/v2/checkout/orders/${orderId}/capture`,
      { method: "POST", body: "{}" },
    )) as RawOrder;
    return mapOrder(raw);
  }

  async refundCapture(
    captureId: string,
    value: string,
    currencyCode: string,
  ): Promise<{ id: string; status: string }> {
    const raw = (await this.request(
      `/v2/payments/captures/${captureId}/refund`,
      {
        method: "POST",
        body: JSON.stringify({
          amount: { value, currency_code: currencyCode },
        }),
      },
    )) as { id: string; status: string };
    return raw;
  }

  // Webhook confirmation is the plan's primary capture confirmation.
  // Verification goes through PayPal's verify-webhook-signature API
  // with the webhook id from the environment; without a webhook id
  // the event cannot be verified and is refused.
  async verifyWebhookSignature(args: {
    headers: Record<string, string | undefined>;
    event: unknown;
  }): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const result = (await this.request(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: JSON.stringify({
          auth_algo: args.headers["paypal-auth-algo"],
          cert_url: args.headers["paypal-cert-url"],
          transmission_id: args.headers["paypal-transmission-id"],
          transmission_sig: args.headers["paypal-transmission-sig"],
          transmission_time: args.headers["paypal-transmission-time"],
          webhook_id: this.cfg.webhookId,
          webhook_event: args.event,
        }),
      },
    )) as { verification_status?: string };
    return result.verification_status === "SUCCESS";
  }
}

// ------------------------------------------------------------------
// Local stub. In-memory only; ids are prefixed STUB- so no surface
// can mistake a stub order for a PayPal order.
// ------------------------------------------------------------------

interface StubOrderState {
  order: PayPalOrder;
  args: CreateOrderArgs;
}

export class LocalStubPayPalClient implements PayPalClient {
  readonly kind = "local-stub" as const;
  private orders = new Map<string, StubOrderState>();
  private counter = 0;
  readonly refunds: Array<{ captureId: string; value: string; currencyCode: string }> = [];

  async createOrder(args: CreateOrderArgs): Promise<PayPalOrder> {
    this.counter += 1;
    const id = `STUB-ORDER-${this.counter}`;
    const order: PayPalOrder = {
      id,
      status: "CREATED",
      links: [
        {
          href: `/stub/checkout/${id}`,
          rel: "approve",
          method: "GET",
        },
      ],
      purchaseUnits: [
        {
          referenceId: args.referenceId,
          amount: { value: args.value, currencyCode: args.currencyCode },
        },
      ],
      raw: { stub: true },
    };
    this.orders.set(id, { order, args });
    return order;
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    const state = this.orders.get(orderId);
    if (!state) throw new Error(`Stub order ${orderId} not found.`);
    return state.order;
  }

  approveStubOrder(orderId: string): PayPalOrder {
    const state = this.orders.get(orderId);
    if (!state) throw new Error(`Stub order ${orderId} not found.`);
    state.order.status = "APPROVED";
    return state.order;
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const state = this.orders.get(orderId);
    if (!state) throw new Error(`Stub order ${orderId} not found.`);
    if (state.order.status !== "APPROVED") {
      throw new Error(
        `Stub order ${orderId} is ${state.order.status}; it must be APPROVED before capture.`,
      );
    }
    const captureId = `STUB-CAPTURE-${this.counter}`;
    state.order.status = "COMPLETED";
    state.order.purchaseUnits[0].payments = {
      captures: [
        {
          id: captureId,
          status: "COMPLETED",
          amount: state.order.purchaseUnits[0].amount,
        },
      ],
    };
    return state.order;
  }

  async refundCapture(
    captureId: string,
    value: string,
    currencyCode: string,
  ): Promise<{ id: string; status: string }> {
    this.refunds.push({ captureId, value, currencyCode });
    return { id: `STUB-REFUND-${this.refunds.length}`, status: "COMPLETED" };
  }

  // Stub webhook events are accepted only when they arrive on the
  // server's stub webhook route, which is itself labelled; signature
  // verification does not apply to a local stub.
  async verifyWebhookSignature(): Promise<boolean> {
    return true;
  }
}

export function createPayPalClient(args: {
  clientId: string | null;
  clientSecret: string | null;
  env: string;
  webhookId: string | null;
}): PayPalClient {
  if (args.clientId && args.clientSecret) {
    return new PayPalSandboxClient({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      env: args.env,
      webhookId: args.webhookId,
    });
  }
  return new LocalStubPayPalClient();
}
