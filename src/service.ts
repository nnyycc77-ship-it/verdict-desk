// The desk service: battery + AI layer + PayPal unlock mechanics.
//
// Tier split (what free means, what paid means):
//   FREE verdict card — the verdict, the verdict reasons, the
//   extracted terms, one evidence quote per check, the plain language
//   explanation, and the count of verified structured terms.
//   PAID full evaluation (unlocked only by a captured PayPal order) —
//   the complete check list with every evidence quote, the verified
//   structured terms with their quotes and the dropped proposals with
//   reasons, the claim checklist, and the smallest edit set.
//   PAID recheck (its own smaller captured order) — the battery and
//   AI layer run again on the poster's edited text, and the movement
//   between the old and new verdicts is shown check by check.
//
// Refund rule from the plan: when a paid evaluation fails after
// capture (for example the posting page can no longer be fetched for
// the fresh full run), the capture is refunded automatically and the
// order is marked refunded. The refund fails closed: if the refund
// call itself fails, the order is marked failed and the error is
// surfaced, never hidden.

import { randomUUID } from "node:crypto";

import {
  buildClaimChecklist,
  DEFAULT_PROFILE,
  fetchPostingText,
  runCheckBattery,
  type CapabilityProfile,
  type EvaluationResult,
} from "./checks.ts";
import { runAiLayer } from "./ai-layer.ts";
import {
  getApproveLink,
  getCapture,
  type PayPalClient,
} from "./paypal.ts";
import type {
  EvaluationRecord,
  OrderRecord,
  RecheckRecord,
  Store,
} from "./store.ts";

export interface DeskConfig {
  fullPrice: string;
  recheckPrice: string;
  currencyCode: string;
  baseUrl: string;
  profile: CapabilityProfile;
}

export const DEFAULT_DESK_CONFIG: DeskConfig = {
  fullPrice: process.env.FULL_VERDICT_PRICE_USD || "5.00",
  recheckPrice: process.env.RECHECK_PRICE_USD || "2.00",
  currencyCode: "USD",
  baseUrl: process.env.DESK_BASE_URL || "http://localhost:8787",
  profile: DEFAULT_PROFILE,
};

export class DeskError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function freeView(record: EvaluationRecord) {
  return {
    id: record.id,
    title: record.title,
    verdict: record.result.verdict,
    verdictReasons: record.result.verdictReasons,
    terms: record.result.terms,
    checks: record.result.checks.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      summary: check.summary,
      evidence: check.evidence.slice(0, 1),
      moreEvidenceCount: Math.max(0, check.evidence.length - 1),
    })),
    explanation: record.explanation,
    verifiedTermCount: record.proposals.verified.length,
    fullUnlocked: record.fullUnlockedAt !== null,
    createdAt: record.createdAt,
  };
}

export function fullView(record: EvaluationRecord) {
  const result = record.fullResult ?? record.result;
  return {
    id: record.id,
    title: record.title,
    verdict: result.verdict,
    verdictReasons: result.verdictReasons,
    terms: result.terms,
    checks: result.checks,
    verifiedTerms: record.proposals.verified,
    droppedProposals: record.proposals.dropped,
    proposalSource: record.proposals.source,
    explanation: record.explanation,
    claimChecklist: record.claimChecklist,
    smallestEditSet: record.edits,
    unlockedAt: record.fullUnlockedAt,
  };
}

export class DeskService {
  private store: Store;
  private paypal: PayPalClient;
  private cfg: DeskConfig;

  constructor(
    store: Store,
    paypal: PayPalClient,
    cfg: DeskConfig = DEFAULT_DESK_CONFIG,
  ) {
    this.store = store;
    this.paypal = paypal;
    this.cfg = cfg;
  }

  get paypalKind(): string {
    return this.paypal.kind;
  }

  async evaluateFree(args: {
    text?: string;
    sourceUrl?: string;
    relatedUrl?: string;
    relatedText?: string;
    title?: string;
  }): Promise<EvaluationRecord> {
    let postingText = args.text ?? "";
    let fetchError: string | null = null;
    if (args.sourceUrl) {
      try {
        postingText = (await fetchPostingText(args.sourceUrl)).text;
      } catch (error) {
        fetchError =
          error instanceof Error ? error.message : String(error);
        if (!postingText) {
          throw new DeskError(
            `The posting page could not be read (${fetchError}) and no posting text was provided. Paste the posting text or try another public URL.`,
          );
        }
      }
    }
    if (!postingText.trim()) {
      throw new DeskError("Provide a posting URL or the posting text.");
    }
    let relatedText: string | null = args.relatedText ?? null;
    if (relatedText === null && args.relatedUrl) {
      try {
        relatedText = (await fetchPostingText(args.relatedUrl)).text;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        fetchError = fetchError
          ? `${fetchError}; related page: ${message}`
          : `Related page could not be read: ${message}`;
      }
    }
    const result = runCheckBattery({
      text: postingText,
      relatedText,
      ...(args.title ? { title: args.title } : {}),
      sourceLabel: args.sourceUrl ?? "Pasted posting",
      relatedLabel: args.relatedUrl ?? "Related sponsor page",
      profile: this.cfg.profile,
      fetchError,
    });
    const ai = await runAiLayer({ text: postingText, result });
    const record: EvaluationRecord = {
      id: randomUUID(),
      title: result.title,
      sourceLabel: args.sourceUrl ?? "Pasted posting",
      sourceUrl: args.sourceUrl ?? null,
      relatedUrl: args.relatedUrl ?? null,
      postingText,
      relatedText,
      result,
      proposals: ai.proposals,
      explanation: ai.explanation,
      explanationSource: ai.explanationSource,
      edits: ai.edits,
      claimChecklist: buildClaimChecklist({
        title: result.title,
        terms: result.terms,
        verdict: result.verdict,
      }),
      fullResult: null,
      fullUnlockedAt: null,
      fullOrderRecordId: null,
      rechecks: [],
      createdAt: new Date().toISOString(),
    };
    return this.store.addEvaluation(record);
  }

  private async createOrderRecord(args: {
    product: OrderRecord["product"];
    evaluationId: string;
    recheckId: string | null;
    value: string;
    description: string;
  }): Promise<OrderRecord> {
    const recordId = randomUUID();
    const order = await this.paypal.createOrder({
      value: args.value,
      currencyCode: this.cfg.currencyCode,
      referenceId: recordId,
      description: args.description,
      returnUrl: `${this.cfg.baseUrl}/checkout/return?record=${recordId}`,
      cancelUrl: `${this.cfg.baseUrl}/checkout/cancel?record=${recordId}`,
    });
    const record: OrderRecord = {
      id: recordId,
      paypalOrderId: order.id,
      product: args.product,
      evaluationId: args.evaluationId,
      recheckId: args.recheckId,
      value: args.value,
      currencyCode: this.cfg.currencyCode,
      status: "created",
      captureId: null,
      captureConfirmedByWebhook: false,
      approveLink: getApproveLink(order),
      refundId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.store.addOrder(record);
  }

  async createFullOrder(evaluationId: string): Promise<OrderRecord> {
    const evaluation = this.store.getEvaluation(evaluationId);
    if (!evaluation) throw new DeskError("Evaluation not found.", 404);
    if (evaluation.fullUnlockedAt) {
      throw new DeskError("This evaluation is already unlocked.");
    }
    return this.createOrderRecord({
      product: "full-verdict",
      evaluationId,
      recheckId: null,
      value: this.cfg.fullPrice,
      description: `Verdict Desk full evaluation: ${evaluation.title}`,
    });
  }

  async createRecheckOrder(args: {
    evaluationId: string;
    editedText: string;
  }): Promise<{ order: OrderRecord; recheck: RecheckRecord }> {
    const evaluation = this.store.getEvaluation(args.evaluationId);
    if (!evaluation) throw new DeskError("Evaluation not found.", 404);
    if (!args.editedText.trim()) {
      throw new DeskError("Provide the edited posting text for the recheck.");
    }
    const recheck: RecheckRecord = {
      id: randomUUID(),
      orderRecordId: "",
      editedText: args.editedText,
      previousVerdict: evaluation.result.verdict,
      result: null,
      explanation: null,
      edits: [],
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    const order = await this.createOrderRecord({
      product: "recheck",
      evaluationId: evaluation.id,
      recheckId: recheck.id,
      value: this.cfg.recheckPrice,
      description: `Verdict Desk recheck: ${evaluation.title}`,
    });
    recheck.orderRecordId = order.id;
    evaluation.rechecks.push(recheck);
    this.store.updateEvaluation(evaluation);
    return { order, recheck };
  }

  // The full evaluation is a fresh deep run, not a re-skin of the
  // free one: URL-sourced postings are refetched, and the battery and
  // AI layer run again on the fresh text. If that run cannot complete
  // after the money was captured, the caller refunds.
  private async assembleFull(evaluation: EvaluationRecord): Promise<{
    fullResult: EvaluationResult;
  }> {
    let text = evaluation.postingText;
    if (evaluation.sourceUrl) {
      const fetched = await fetchPostingText(evaluation.sourceUrl);
      text = fetched.text;
    }
    const fullResult = runCheckBattery({
      text,
      relatedText: evaluation.relatedText,
      title: evaluation.title,
      sourceLabel: evaluation.sourceLabel,
      relatedLabel: evaluation.relatedUrl ?? "Related sponsor page",
      profile: this.cfg.profile,
    });
    return { fullResult };
  }

  private async refundOrder(
    order: OrderRecord,
    captureId: string,
  ): Promise<void> {
    const refund = await this.paypal.refundCapture(
      captureId,
      order.value,
      order.currencyCode,
    );
    order.status = "refunded";
    order.refundId = refund.id;
    order.updatedAt = new Date().toISOString();
    this.store.updateOrder(order);
  }

  // Capture an approved order and apply the unlock (or the recheck).
  // Used by the checkout return route after the buyer approves on
  // PayPal's page (or on the local stub page in stub mode).
  async captureAndUnlock(orderRecordId: string): Promise<{
    order: OrderRecord;
    evaluation: EvaluationRecord;
    recheck: RecheckRecord | null;
  }> {
    const order = this.store.getOrder(orderRecordId);
    if (!order) throw new DeskError("Order not found.", 404);
    const evaluation = this.store.getEvaluation(order.evaluationId);
    if (!evaluation) throw new DeskError("Evaluation not found.", 404);
    if (order.status === "captured") {
      const recheck =
        evaluation.rechecks.find((r) => r.id === order.recheckId) ?? null;
      return { order, evaluation, recheck };
    }
    if (order.status === "refunded" || order.status === "failed") {
      throw new DeskError(`Order is ${order.status} and cannot be captured.`);
    }
    const remote = await this.paypal.getOrder(order.paypalOrderId);
    if (remote.status !== "APPROVED" && remote.status !== "COMPLETED") {
      throw new DeskError(
        `Order is ${remote.status} at PayPal; it must be APPROVED before capture.`,
      );
    }
    const captured =
      remote.status === "COMPLETED"
        ? remote
        : await this.paypal.captureOrder(order.paypalOrderId);
    const capture = getCapture(captured);
    if (!capture || capture.status !== "COMPLETED") {
      order.status = "failed";
      order.updatedAt = new Date().toISOString();
      this.store.updateOrder(order);
      throw new DeskError(
        "Capture did not complete; nothing was unlocked and no refund was needed.",
      );
    }
    order.status = "captured";
    order.captureId = capture.id;
    order.updatedAt = new Date().toISOString();
    this.store.updateOrder(order);

    try {
      if (order.product === "full-verdict") {
        const { fullResult } = await this.assembleFull(evaluation);
        evaluation.fullResult = fullResult;
        evaluation.fullUnlockedAt = new Date().toISOString();
        evaluation.fullOrderRecordId = order.id;
        this.store.updateEvaluation(evaluation);
        return { order, evaluation, recheck: null };
      }
      const recheck = evaluation.rechecks.find((r) => r.id === order.recheckId);
      if (!recheck) throw new Error("Recheck record missing.");
      const result = runCheckBattery({
        text: recheck.editedText,
        title: evaluation.title,
        sourceLabel: "Edited posting (recheck)",
        profile: this.cfg.profile,
      });
      const ai = await runAiLayer({ text: recheck.editedText, result });
      recheck.result = result;
      recheck.explanation = ai.explanation;
      recheck.edits = ai.edits;
      recheck.status = "completed";
      recheck.completedAt = new Date().toISOString();
      this.store.updateEvaluation(evaluation);
      return { order, evaluation, recheck };
    } catch (error) {
      // Paid evaluation failed after capture: automatic refund.
      try {
        await this.refundOrder(order, capture.id);
      } catch (refundError) {
        order.status = "failed";
        order.updatedAt = new Date().toISOString();
        this.store.updateOrder(order);
        throw new DeskError(
          `The paid evaluation failed after capture and the automatic refund also failed (${refundError instanceof Error ? refundError.message : String(refundError)}). Order ${order.id} needs manual attention.`,
          500,
        );
      }
      if (order.product === "recheck") {
        const recheck = evaluation.rechecks.find(
          (r) => r.id === order.recheckId,
        );
        if (recheck) {
          recheck.status = "refunded";
          this.store.updateEvaluation(evaluation);
        }
      }
      throw new DeskError(
        `The paid evaluation failed after capture (${error instanceof Error ? error.message : String(error)}). The capture was refunded in full.`,
        502,
      );
    }
  }

  // Webhook confirmation: PAYMENT.CAPTURE.COMPLETED for a capture we
  // hold marks the order confirmed; PAYMENT.CAPTURE.REFUNDED keeps
  // the local status in step with PayPal.
  handleWebhookEvent(event: {
    event_type?: string;
    resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
  }): { handled: boolean; orderId?: string } {
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (!orderId) return { handled: false };
    const order = this.store.getOrderByPayPalId(orderId);
    if (!order) return { handled: false };
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      order.captureConfirmedByWebhook = true;
      if (event.resource?.id) order.captureId = event.resource.id;
      order.updatedAt = new Date().toISOString();
      this.store.updateOrder(order);
      return { handled: true, orderId: order.id };
    }
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      order.status = "refunded";
      order.updatedAt = new Date().toISOString();
      this.store.updateOrder(order);
      return { handled: true, orderId: order.id };
    }
    return { handled: false };
  }

  receipt(orderRecordId: string) {
    const order = this.store.getOrder(orderRecordId);
    if (!order) throw new DeskError("Order not found.", 404);
    const evaluation = this.store.getEvaluation(order.evaluationId);
    return {
      orderId: order.id,
      paypalOrderId: order.paypalOrderId,
      product: order.product,
      evaluationTitle: evaluation?.title ?? "",
      value: order.value,
      currencyCode: order.currencyCode,
      status: order.status,
      captureId: order.captureId,
      captureConfirmedByWebhook: order.captureConfirmedByWebhook,
      refundId: order.refundId,
      paypalKind: this.paypal.kind,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
