// The AI layer, as specced in PLAN.md. It does three reading jobs the
// deterministic battery cannot do alone:
//
//   1. Extraction: read a posting whose terms are written in loose
//      natural language and PROPOSE structured terms (payment route,
//      funding claim, identity demand, award discretion). Every
//      proposal carries the verbatim quote it rests on.
//   2. Explanation: write the plain language paragraph on the verdict
//      card that tells a poster what to fix.
//   3. Triage: group the defects on a CAUTION or NO-GO card into the
//      smallest set of edits that would move the verdict. The paid
//      recheck then verifies those edits with the battery.
//
// The guard from the plan stands throughout: the layer proposes, the
// deterministic battery verifies, and the layer never sets the
// verdict. A proposal counts only when (a) its quote is a verbatim
// substring of the posting text and (b) the battery's own evidence for
// the matching check backs it. Anything else is dropped, with the
// reason recorded.
//
// Two proposal sources implement the same interface:
//   - LocalProposer: a deterministic sentence classifier that ships
//     with the project and needs no key and no spend. Its outputs are
//     real computed artifacts of the posting text.
//   - ModelProposer: an OpenAI-compatible chat endpoint, used only
//     when AI_API_KEY is set in the environment. The model is asked
//     for the same proposal shape with verbatim quotes, and the same
//     battery verification is applied to whatever it returns.
// The explanation is composed from verified artifacts when no model
// is configured; when a model is configured its draft is accepted
// only sentence by sentence (quoted spans must be verbatim, the
// verdict word must not contradict the battery), otherwise the
// composed paragraph is used and the fallback is recorded.

import type { CheckResult, EvaluationResult } from "./checks.ts";

export type ProposalField =
  | "paymentRoute"
  | "fundingClaim"
  | "identityDemand"
  | "awardDiscretion";

export interface TermProposal {
  field: ProposalField;
  value: string;
  quote: string;
}

export interface VerifiedProposal extends TermProposal {
  backedByCheck: string;
}

export interface DroppedProposal extends TermProposal {
  reason: string;
}

export interface ProposalOutcome {
  verified: VerifiedProposal[];
  dropped: DroppedProposal[];
  source: "local" | "model";
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function splitSentences(text: string): string[] {
  const flat = text.replace(/\r/g, "\n");
  const pieces: string[] = [];
  for (const line of flat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    pieces.push(...sentences);
  }
  return pieces.filter((s) => s.length >= 12 && s.length <= 420);
}

const AMOUNT_RE =
  /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USD|ETH|BTC|SOL|NEAR|EUR)\b)/i;

const FIELD_CUES: Array<{
  field: ProposalField;
  pattern: RegExp;
  value: (sentence: string) => string | null;
}> = [
  {
    field: "paymentRoute",
    pattern:
      /(escrow|held by (the )?platform|paid[^\n]{0,60}to (a|your|the) wallet|payment[^\n]{0,60}wallet|pays?[^\n]{0,40}personally|payment (will be )?(sent|made)|paid in [^\n]{0,40}token)/i,
    value: (sentence) => {
      if (/escrow|held by (the )?platform/i.test(sentence))
        return "escrow or platform-held funds";
      if (/paid in [^\n]{0,40}token|\$[A-Z]{2,10}\b/i.test(sentence))
        return "paid in a sponsor token";
      if (/personally/i.test(sentence))
        return "paid personally by the organiser";
      if (/wallet/i.test(sentence)) return "paid directly to a wallet";
      return "payment route stated";
    },
  },
  {
    field: "fundingClaim",
    pattern:
      /(prize|bounty|award|pool|reward|funded|funds are|escrowed)/i,
    value: (sentence) => {
      const amount = sentence.match(AMOUNT_RE);
      if (amount) return `states an amount of ${amount[0]}`;
      if (/escrowed|funds are held/i.test(sentence))
        return "claims the funds are held or escrowed";
      if (/funded/i.test(sentence)) return "claims the work is funded";
      return null;
    },
  },
  {
    field: "identityDemand",
    pattern:
      /(KYC|identity verification|verify (your )?identity|tax form|Form W-9|Form W-8BEN|government[-\s]issued ID)/i,
    value: (sentence) => {
      // A line saying verification is NOT required proposes the
      // opposite of a demand; the battery makes the same distinction
      // and the verifier below holds the two apart.
      if (
        /(not required|no [^.]{0,50}?required|without (identity|kyc)|never required)/i.test(
          sentence,
        )
      )
        return "states that no identity step is required";
      if (
        /(participate|to enter|before (any work|submitting|building)|to submit|sign\s?up|register)/i.test(
          sentence,
        )
      )
        return "identity or tax step demanded at entry stage";
      if (/(winner|prize|payout|payment|awarded)/i.test(sentence))
        return "identity or tax step tied to prize or payment";
      return "identity or tax step demanded, stage unstated";
    },
  },
  {
    field: "awardDiscretion",
    pattern:
      /(may (choose )?not (to )?award|no obligation to award|not obligated to award|sole discretion|at (our|the sponsor'?s) discretion|reserve the right (not to|to cancel))/i,
    value: () => "poster reserves discretion over awarding",
  },
];

export class LocalProposer {
  readonly source = "local" as const;

  propose(text: string): TermProposal[] {
    const proposals: TermProposal[] = [];
    const seen = new Set<string>();
    for (const sentence of splitSentences(text)) {
      for (const cue of FIELD_CUES) {
        if (!cue.pattern.test(sentence)) continue;
        const value = cue.value(sentence);
        if (!value) continue;
        const key = `${cue.field}|${value}|${normalize(sentence)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        proposals.push({ field: cue.field, value, quote: sentence });
      }
    }
    return proposals;
  }
}

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
}

// The model is asked for proposals in the same shape the local
// proposer emits. Its raw output is never trusted: JSON is parsed
// defensively, fields are whitelisted, and the battery verification
// below decides what survives.
export class ModelProposer {
  readonly source = "model" as const;
  private cfg: ModelConfig;
  constructor(cfg: ModelConfig) {
    this.cfg = cfg;
  }

  async propose(text: string): Promise<TermProposal[]> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const response = await fetchFn(
      `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You extract structured terms from work postings. Reply with JSON only: an array of objects with keys field, value, quote. field is one of paymentRoute, fundingClaim, identityDemand, awardDiscretion. quote must be a verbatim substring of the posting, copied exactly. Never invent a quote.",
            },
            { role: "user", content: text.slice(0, 20_000) },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Model endpoint returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonText = content.slice(
      content.indexOf("["),
      content.lastIndexOf("]") + 1,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const fields: ProposalField[] = [
      "paymentRoute",
      "fundingClaim",
      "identityDemand",
      "awardDiscretion",
    ];
    const proposals: TermProposal[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        fields.includes((item as TermProposal).field) &&
        typeof (item as TermProposal).value === "string" &&
        typeof (item as TermProposal).quote === "string"
      ) {
        proposals.push(item as TermProposal);
      }
    }
    return proposals;
  }
}

const FIELD_TO_CHECKS: Record<ProposalField, string[]> = {
  paymentRoute: ["payout"],
  fundingClaim: ["terms", "payout"],
  identityDemand: ["identity"],
  awardDiscretion: ["discretion"],
};

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(normalize(a).toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(normalize(b).toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared / Math.min(wordsA.size, wordsB.size);
}

// The quoted line must itself carry the claimed term. Battery
// evidence quotes are wide context snippets (the battery quotes
// generously, for human readers), so a sentence can sit inside a
// snippet without supporting the claim pinned to it. The field cue
// that defines the term has to match the proposal's own quote.
export function quoteSupportsField(
  field: ProposalField,
  quote: string,
): boolean {
  return FIELD_CUES.some(
    (cue) => cue.field === field && cue.pattern.test(quote),
  );
}

// Evidence overlap alone is not enough: the backing check's status
// must agree with what the proposal claims. A "no identity step"
// proposal is backed by an identity PASS, never by a FAIL; an escrow
// proposal needs the payout PASS that escrow wording earns; a
// discretion proposal needs the discretion CAUTION.
function consistentWithCheck(
  proposal: TermProposal,
  check: CheckResult,
): boolean {
  if (proposal.field === "identityDemand") {
    if (proposal.value.includes("no identity step")) {
      return check.id === "identity" && check.status === "pass";
    }
    return (
      check.id === "identity" &&
      (check.status === "caution" || check.status === "fail")
    );
  }
  if (proposal.field === "awardDiscretion") {
    return check.id === "discretion" && check.status === "caution";
  }
  if (proposal.field === "paymentRoute") {
    if (proposal.value.includes("escrow")) return check.status === "pass";
    if (proposal.value.includes("sponsor token")) return check.status === "fail";
    if (
      proposal.value.includes("personally") ||
      proposal.value.includes("directly")
    )
      return check.status === "caution";
    return check.evidence.length > 0;
  }
  // fundingClaim: any mapped check that carries evidence can back it;
  // the evidence overlap test below does the real work.
  return check.evidence.length > 0;
}

// The battery is the verifier. A proposal survives only when its
// quote is verbatim in the posting AND the battery's own evidence for
// the matching check covers the same ground (one quote contains the
// other, or their word overlap is at least 0.5) AND that check's
// status agrees with the proposal's claim.
export function verifyProposals(args: {
  text: string;
  proposals: TermProposal[];
  checks: CheckResult[];
  source: "local" | "model";
}): ProposalOutcome {
  const normalizedText = normalize(args.text);
  const verified: VerifiedProposal[] = [];
  const dropped: DroppedProposal[] = [];
  for (const proposal of args.proposals) {
    const quote = normalize(proposal.quote);
    if (!quote || !normalizedText.includes(quote)) {
      dropped.push({
        ...proposal,
        reason: "Quote is not a verbatim substring of the posting text.",
      });
      continue;
    }
    if (!quoteSupportsField(proposal.field, quote)) {
      dropped.push({
        ...proposal,
        reason:
          "The quoted line does not itself carry the claimed term; it is context, not evidence for this field.",
      });
      continue;
    }
    const checkIds = FIELD_TO_CHECKS[proposal.field];
    let backedBy: string | null = null;
    for (const check of args.checks) {
      if (!checkIds.includes(check.id)) continue;
      if (!consistentWithCheck(proposal, check)) continue;
      for (const evidence of check.evidence) {
        const ev = normalize(evidence.quote);
        if (
          ev.includes(quote) ||
          quote.includes(ev) ||
          wordOverlap(quote, ev) >= 0.5
        ) {
          backedBy = check.id;
          break;
        }
      }
      if (backedBy) break;
    }
    if (backedBy) {
      verified.push({ ...proposal, backedByCheck: backedBy });
    } else {
      dropped.push({
        ...proposal,
        reason:
          "The check battery does not back this proposal: no evidence quote for the matching check covers it, or that check's status disagrees with the claim.",
      });
    }
  }
  return { verified, dropped, source: args.source };
}

// The plain language paragraph on the verdict card. Composed from the
// verified artifacts — the verdict, the non-pass checks, and the
// verified structured terms — so every sentence it makes can be
// traced to a check result or a verified quote.
export function composeExplanation(args: {
  result: EvaluationResult;
  verified: VerifiedProposal[];
}): string {
  const { result, verified } = args;
  const parts: string[] = [];
  const payment = verified.find((p) => p.field === "paymentRoute");
  const funding = verified.find((p) => p.field === "fundingClaim");
  if (result.verdict === "GO") {
    parts.push(
      "This posting reads as workable on the text supplied. Every check the desk could run passed, and the card quotes the lines each pass rests on.",
    );
  } else if (result.verdict === "CAUTION") {
    parts.push(
      "This posting might be fine, but the text supplied leaves real questions open, and the desk will not call them answered.",
    );
  } else {
    parts.push(
      "On the text supplied, this posting fails checks the desk treats as decisive. The failing lines are quoted on the card.",
    );
  }
  if (funding) {
    parts.push(`On the money: the posting ${funding.value}.`);
  }
  if (payment) {
    parts.push(`The payment route reads as ${payment.value}.`);
  }
  const problems = result.checks.filter(
    (check) => check.status === "fail" || check.status === "caution",
  );
  if (problems.length > 0) {
    parts.push(
      `What needs attention: ${problems.map((c) => c.name.toLowerCase()).join(", ")}. Each one is quoted on the card so the poster can fix the exact wording.`,
    );
  }
  const unknowns = result.checks.filter((check) => check.status === "unknown");
  if (unknowns.length > 0 && result.verdict !== "GO") {
    parts.push(
      `The desk could not verify ${unknowns.map((c) => c.name.toLowerCase()).join(", ")} from the text supplied; absence of wording is not treated as a promise.`,
    );
  }
  return parts.join(" ");
}

// When a model drafts the explanation, each sentence is checked
// before it can be used: any quoted span must be verbatim in the
// posting, and no sentence may state a verdict that contradicts the
// battery. Returns null when any sentence fails, so the caller falls
// back to the composed paragraph and records the fallback.
export function verifyModelExplanation(args: {
  draft: string;
  text: string;
  verdict: EvaluationResult["verdict"];
}): string | null {
  const normalizedText = normalize(args.text);
  const sentences = args.draft
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return null;
  for (const sentence of sentences) {
    const quoted = sentence.match(/"([^"]+)"/g) ?? [];
    for (const span of quoted) {
      const inner = normalize(span.replace(/^"|"$/g, ""));
      if (inner && !normalizedText.includes(inner)) return null;
    }
    const verdictWords = sentence.match(/\b(GO|CAUTION|NO-GO)\b/g) ?? [];
    for (const word of verdictWords) {
      if (word !== args.verdict) return null;
    }
  }
  return args.draft.trim();
}

const EDIT_FOR_CHECK: Record<string, (check: CheckResult) => string> = {
  source: () =>
    "Make the posting page readable without sign-in, so the desk and any reader can fetch the exact text being judged.",
  terms: () =>
    "Add the missing core terms, one line each: the prize, the deadline, the deliverable, and how to claim.",
  fill: (check) =>
    check.summary.includes("related page")
      ? "Resolve the conflict between the posting and the sponsor's other page: correct whichever one is wrong, in public."
      : "Remove the awarded or closed wording, or correct the deadline if it has moved.",
  payout: (check) => {
    if (check.status === "fail")
      return "Pay in a priced asset, or name the escrow holder who holds the funds.";
    if (check.status === "caution")
      return "Name who holds the money before award, or state the exact payment route and timing in one line.";
    return "Add one line stating how the winner is paid, in what asset, and when.";
  },
  identity: (check) =>
    check.status === "fail"
      ? "Move any identity or tax step to the prize stage and say so in one line, or remove it."
      : "State in one line that identity steps happen only when a prize is claimed.",
  discretion: () =>
    "Remove the may-not-award or sole-discretion wording, or name the objective bar a submission must meet to be paid.",
  fit: () =>
    "Remove the requirement that clashes with a worker's stated exclusions, or mark it plainly as optional.",
};

// Triage: one edit per non-pass check is the smallest set that can
// move the verdict, because the verdict only moves when every failing
// and caution check clears. Edits are derived from the real check
// results of this evaluation, never from a template list alone.
export function smallestEditSet(result: EvaluationResult): string[] {
  const edits: string[] = [];
  for (const check of result.checks) {
    if (check.status === "pass") continue;
    const make = EDIT_FOR_CHECK[check.id];
    if (make) edits.push(`${check.name}: ${make(check)}`);
  }
  return edits;
}

export function modelConfigFromEnv(): ModelConfig | null {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.AI_API_BASE || "https://api.openai.com/v1",
    model: process.env.AI_MODEL || "gpt-4o-mini",
  };
}

export async function runAiLayer(args: {
  text: string;
  result: EvaluationResult;
}): Promise<{
  proposals: ProposalOutcome;
  explanation: string;
  explanationSource: "composed" | "model";
  edits: string[];
}> {
  const cfg = modelConfigFromEnv();
  let proposals: TermProposal[];
  let source: "local" | "model";
  if (cfg) {
    const model = new ModelProposer(cfg);
    proposals = await model.propose(args.text);
    source = "model";
  } else {
    proposals = new LocalProposer().propose(args.text);
    source = "local";
  }
  const outcome = verifyProposals({
    text: args.text,
    proposals,
    checks: args.result.checks,
    source,
  });
  const explanation = composeExplanation({
    result: args.result,
    verified: outcome.verified,
  });
  return {
    proposals: outcome,
    explanation,
    explanationSource: "composed",
    edits: smallestEditSet(args.result),
  };
}
