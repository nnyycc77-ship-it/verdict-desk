// Tiny JSON-file store for evaluations and orders. The desk is a
// single-process demo, so a flat file with write-through saves is
// enough; tests use the in-memory mode (path null). No secrets are
// ever stored here — orders keep PayPal ids and statuses only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EvaluationResult } from "./checks.ts";
import type { ProposalOutcome } from "./ai-layer.ts";
import type { ClaimStep } from "./checks.ts";

export interface RecheckRecord {
  id: string;
  orderRecordId: string;
  editedText: string;
  previousVerdict: EvaluationResult["verdict"];
  result: EvaluationResult | null;
  explanation: string | null;
  edits: string[];
  status: "pending" | "completed" | "refunded";
  createdAt: string;
  completedAt: string | null;
}

export interface EvaluationRecord {
  id: string;
  title: string;
  sourceLabel: string;
  sourceUrl: string | null;
  relatedUrl: string | null;
  postingText: string;
  relatedText: string | null;
  result: EvaluationResult;
  proposals: ProposalOutcome;
  explanation: string;
  explanationSource: "composed" | "model";
  edits: string[];
  claimChecklist: ClaimStep[];
  fullResult: EvaluationResult | null;
  fullUnlockedAt: string | null;
  fullOrderRecordId: string | null;
  rechecks: RecheckRecord[];
  createdAt: string;
}

export interface OrderRecord {
  id: string;
  paypalOrderId: string;
  product: "full-verdict" | "recheck";
  evaluationId: string;
  recheckId: string | null;
  value: string;
  currencyCode: string;
  status:
    | "created"
    | "approved"
    | "captured"
    | "refunded"
    | "failed";
  captureId: string | null;
  captureConfirmedByWebhook: boolean;
  approveLink: string | null;
  refundId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoreData {
  evaluations: EvaluationRecord[];
  orders: OrderRecord[];
}

export class Store {
  private data: StoreData = { evaluations: [], orders: [] };
  private path: string | null;

  constructor(path: string | null) {
    this.path = path;
    if (path && existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as StoreData;
      } catch {
        this.data = { evaluations: [], orders: [] };
      }
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  addEvaluation(record: EvaluationRecord): EvaluationRecord {
    this.data.evaluations.push(record);
    this.save();
    return record;
  }

  getEvaluation(id: string): EvaluationRecord | null {
    return this.data.evaluations.find((e) => e.id === id) ?? null;
  }

  listEvaluations(): EvaluationRecord[] {
    return [...this.data.evaluations];
  }

  updateEvaluation(record: EvaluationRecord): void {
    const index = this.data.evaluations.findIndex((e) => e.id === record.id);
    if (index >= 0) this.data.evaluations[index] = record;
    this.save();
  }

  addOrder(record: OrderRecord): OrderRecord {
    this.data.orders.push(record);
    this.save();
    return record;
  }

  getOrder(id: string): OrderRecord | null {
    return this.data.orders.find((o) => o.id === id) ?? null;
  }

  getOrderByPayPalId(paypalOrderId: string): OrderRecord | null {
    return (
      this.data.orders.find((o) => o.paypalOrderId === paypalOrderId) ?? null
    );
  }

  updateOrder(record: OrderRecord): void {
    const index = this.data.orders.findIndex((o) => o.id === record.id);
    if (index >= 0) this.data.orders[index] = record;
    this.save();
  }
}
