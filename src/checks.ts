// Verdict Desk check battery — vendored verbatim from the Builder.io
// Verdict Desk build (builder-io/app/verdict-desk/server/lib/checks.ts),
// where it shipped as the evaluation core of the submitted Builder.io
// entry. Fully deterministic: no LLM calls, and a check that cannot read
// its fact returns "unknown", never a guessed pass or fail. Every claim
// in a check summary is backed by a quoted evidence line from the
// posting or a related sponsor page. The only change in this copy is
// this header comment.

export interface CapabilityProfile {
  skills: string[];
  exclusions: string[];
  payoutRequirements: string[];
  notes: string;
}

export interface Evidence {
  quote: string;
  source: string;
}

export type CheckStatus = "pass" | "caution" | "fail" | "unknown";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  summary: string;
  evidence: Evidence[];
}

export interface ExtractedTerms {
  prizeText: string | null;
  deadlineText: string | null;
  deliverableText: string | null;
  claimRouteText: string | null;
}

export interface EvaluationResult {
  title: string;
  terms: ExtractedTerms;
  checks: CheckResult[];
  verdict: "GO" | "CAUTION" | "NO-GO";
  verdictReasons: string[];
}

export const DEFAULT_PROFILE: CapabilityProfile = {
  skills: [
    "verification",
    "screening",
    "research",
    "data analysis",
    "documentation",
    "API integration",
    "TypeScript",
  ],
  exclusions: [
    "social engagement",
    "testimonials",
    "physical presence",
    "custody of funds",
  ],
  payoutRequirements: ["priced payout asset"],
  notes: "Default desk profile. Edit it to match the work you actually take.",
};

const MAX_EVIDENCE = 3;

function cleanText(input: string): string {
  return input
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|li|tr|h1|h2|h3|h4)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = withBreaks
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
  return cleanText(decoded);
}

export async function fetchPostingText(
  url: string,
): Promise<{ text: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "VerdictDesk/0.1 (posting evaluation)",
        accept: "text/html,text/plain,application/json;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Fetch returned HTTP ${response.status}`);
    }
    const raw = (await response.text()).slice(0, 500_000);
    const contentType = response.headers.get("content-type") ?? "";
    const text = contentType.includes("html") || /<html[\s>]/i.test(raw)
      ? htmlToText(raw)
      : cleanText(raw);
    return { text, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 110);
  const end = Math.min(text.length, index + length + 140);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function findEvidence(
  text: string,
  pattern: RegExp,
  source: string,
  max = MAX_EVIDENCE,
): Evidence[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const seen = new Set<string>();
  const evidence: Evidence[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null && evidence.length < max) {
    const quote = snippetAround(text, match.index, match[0].length);
    if (quote && !seen.has(quote)) {
      seen.add(quote);
      evidence.push({ quote, source });
    }
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return evidence;
}

function firstEvidence(
  text: string,
  pattern: RegExp,
  source: string,
): Evidence | null {
  return findEvidence(text, pattern, source, 1)[0] ?? null;
}

function inferTitle(text: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim().slice(0, 140);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => line.length >= 12 && line.length <= 140);
  return useful ?? "Untitled posting";
}

const AMOUNT =
  /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USD|ETH|BTC|SOL|NEAR|EUR)\b)/i;

function extractTerms(text: string, source: string): ExtractedTerms {
  const prize = firstEvidence(
    text,
    new RegExp(
      `(?:prize|bounty|award|pool|reward|grand prize|total)[^\\n]{0,90}?${AMOUNT.source}|${AMOUNT.source}[^\\n]{0,60}?(?:prize|bounty|award|pool|reward)`,
      "i",
    ),
    source,
  );
  const deadline = firstEvidence(
    text,
    /(?:deadline|submit by|submissions? close|closes|due by)[^\n]{0,110}?(?:\d{4}|January|February|March|April|May|June|July|August|September|October|November|December)/i,
    source,
  );
  const deliverable = firstEvidence(
    text,
    /(?:deliverable|build|create|submit|develop)[^\n]{0,130}?(?:app|tool|integration|repository|repo|report|demo|application)/i,
    source,
  );
  const claim = firstEvidence(
    text,
    /(?:claim|submission form|submit (?:through|via|at)|email[^\n]{0,50}@|send[^\n]{0,60}(?:repo|link|wallet))/i,
    source,
  );
  return {
    prizeText: prize?.quote ?? null,
    deadlineText: deadline?.quote ?? null,
    deliverableText: deliverable?.quote ?? null,
    claimRouteText: claim?.quote ?? null,
  };
}

function parseDeadline(deadlineText: string | null): Date | null {
  if (!deadlineText) return null;
  const parsed = Date.parse(deadlineText.replace(/at\s+/i, " "));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export function runCheckBattery(args: {
  text: string;
  relatedText?: string | null;
  sourceLabel?: string;
  relatedLabel?: string;
  profile: CapabilityProfile;
  fetchError?: string | null;
  title?: string;
}): EvaluationResult {
  const text = cleanText(args.text);
  const relatedText = args.relatedText ? cleanText(args.relatedText) : null;
  const source = args.sourceLabel || "Posting";
  const relatedSource = args.relatedLabel || "Related sponsor page";
  const profile = args.profile;
  const terms = extractTerms(text, source);
  const checks: CheckResult[] = [];

  if (args.fetchError) {
    checks.push({
      id: "source",
      name: "Source read",
      status: "unknown",
      summary: `The posting page could not be read directly: ${args.fetchError}. Any text evaluated here came from what the user pasted, so page-only terms may be missing.`,
      evidence: [],
    });
  }

  const foundTerms = [
    terms.prizeText ? "prize" : null,
    terms.deadlineText ? "deadline" : null,
    terms.deliverableText ? "deliverable" : null,
    terms.claimRouteText ? "claim route" : null,
  ].filter(Boolean) as string[];
  checks.push({
    id: "terms",
    name: "Terms check",
    status: foundTerms.length >= 3 ? "pass" : foundTerms.length > 0 ? "caution" : "unknown",
    summary:
      foundTerms.length > 0
        ? `Found ${foundTerms.join(", ")} in the posting text. ${foundTerms.length < 4 ? "Some core terms were not found and stay unverified." : "All four core terms were found."}`
        : "No prize, deadline, deliverable, or claim route could be extracted from the supplied text.",
    evidence: [terms.prizeText, terms.deadlineText, terms.deliverableText, terms.claimRouteText]
      .filter(Boolean)
      .map((quote) => ({ quote: quote as string, source })),
  });

  const awardedPattern =
    /(?:all\s+\w*\s*slots?\s+(?:are\s+|were\s+)?(?:awarded|paid)|slots?\s+(?:are|were)\s+awarded|winners?\s+(?:announced|selected)|already\s+awarded|submissions?\s+(?:are\s+)?closed|round\s+(?:is\s+)?closed|awarded\s+and\s+paid|have\s+been\s+paid|cannot\s+earn\s+a\s+bounty)/i;
  const mainAwarded = findEvidence(text, awardedPattern, source);
  const relatedAwarded = relatedText
    ? findEvidence(relatedText, awardedPattern, relatedSource)
    : [];
  const mainOpen = firstEvidence(
    text,
    /(?:submissions?\s+close|submit\s+by|open\s+to|accepting\s+(?:entries|submissions)|deadline|round\s+closes)/i,
    source,
  );
  const deadlineDate = parseDeadline(terms.deadlineText);
  const expired = deadlineDate ? deadlineDate.getTime() < Date.now() : false;
  if (relatedAwarded.length > 0) {
    checks.push({
      id: "fill",
      name: "Fill check",
      status: "fail",
      summary: mainOpen
        ? "The posting still reads as open, while a related page from the same sponsor says the opportunity was awarded or closed. Treat the prize as unavailable until the sponsor resolves the conflict."
        : "A related page from the same sponsor says the opportunity was awarded, paid, or closed, and the posting itself does not disclose that. Treat the prize as unavailable until the sponsor resolves the conflict.",
      evidence: [...(mainOpen ? [mainOpen] : []), ...relatedAwarded],
    });
  } else if (mainAwarded.length > 0 || expired) {
    checks.push({
      id: "fill",
      name: "Fill check",
      status: "fail",
      summary: expired
        ? "The extracted deadline is in the past."
        : "The posting text itself carries awarded or closed language.",
      evidence: mainAwarded.length > 0 ? mainAwarded : terms.deadlineText
        ? [{ quote: terms.deadlineText, source }]
        : [],
    });
  } else {
    checks.push({
      id: "fill",
      name: "Fill check",
      status: "unknown",
      summary:
        "No awarded, closed, or expired signal was found in the supplied text. That is not proof the opportunity is still open; fill status can change outside the posting page.",
      evidence: [],
    });
  }

  const escrow = findEvidence(
    text,
    /(?:escrow|funds?\s+(?:are\s+)?held\s+by\s+(?:the\s+)?platform|platform\s+holds)/i,
    source,
  );
  const directPay = findEvidence(
    text,
    /(?:paid\s+(?:in\s+)?(?:USDC|USD|ETH|BTC|SOL)(?:\s+on\s+\w+)?\s+to\s+(?:a|your|the)\s+wallet|payment\s+(?:will\s+be\s+)?(?:sent|made)\s+to|(?:payment|paid)[^\n]{0,60}?to\s+(?:a|your|the)\s+wallet|winner\s+names\s+the\s+wallet|paid\s+personally|pays?\s+\w*\s*personally|payment\s+from)/i,
    source,
  );
  const sponsorToken = findEvidence(
    text,
    /(?:paid\s+in\s+(?:the\s+)?(?:sponsor'?s\s+|our\s+)?(?:own\s+)?\$?[A-Z]{2,10}\s+token|payout\s+in\s+\$?[A-Z]{2,10}\b|in\s+(?:our|their)\s+(?:\$?[A-Z]{2,10}\s+)?token)/i,
    source,
  );
  const wantsPricedAsset = profile.payoutRequirements.some((item) =>
    /priced/i.test(item),
  );
  if (sponsorToken.length > 0 && wantsPricedAsset) {
    checks.push({
      id: "payout",
      name: "Payout check",
      status: "fail",
      summary:
        "The payout appears to be a sponsor token rather than a priced asset, and the saved profile requires a priced payout asset. A face value in dollars is not verified by the posting itself.",
      evidence: sponsorToken,
    });
  } else if (escrow.length > 0) {
    checks.push({
      id: "payout",
      name: "Payout check",
      status: "pass",
      summary: "The posting describes escrow or platform-held funds.",
      evidence: escrow,
    });
  } else if (directPay.length > 0) {
    checks.push({
      id: "payout",
      name: "Payout check",
      status: "caution",
      summary:
        "Payment appears to come directly from the sponsor to a wallet, with no escrow described in the supplied text. The promise is only as strong as the sponsor.",
      evidence: directPay,
    });
  } else {
    checks.push({
      id: "payout",
      name: "Payout check",
      status: "unknown",
      summary: "No escrow, direct payment route, or payout asset could be verified from the supplied text.",
      evidence: [],
    });
  }

  const identityAll = findEvidence(
    text,
    /(?:KYC|identity\s+verification|verify\s+(?:your\s+)?identity|tax\s+form|Form\s+W-9|Form\s+W-8BEN|government[-\s]issued\s+ID)/i,
    source,
  );
  // A line saying verification is NOT required is evidence of the
  // opposite; it must never count as an identity requirement.
  const negatedIdentityLine = (quote: string) =>
    /(?:not\s+required|no\s+[^.]{0,50}?\brequired\b|without\s+(?:identity|kyc)|never\s+required|do\s+not\s+upload|never\s+upload)/i.test(
      quote,
    );
  const identity = identityAll.filter(
    (item) => !negatedIdentityLine(item.quote),
  );
  const explicitlyNoIdentity =
    identityAll.length > 0 && identity.length === 0;
  // Stage is judged on the sentences that carry the identity wording
  // themselves, not on the wider evidence window: entry stage wording
  // (to participate, before any work is reviewed) always wins over a
  // prize mention elsewhere in the text.
  const identityPattern =
    /(?:KYC|identity\s+verification|verify\s+(?:your\s+)?identity|tax\s+form|Form\s+W-9|Form\s+W-8BEN|government[-\s]issued\s+ID)/i;
  const identitySentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length > 0 &&
        identityPattern.test(sentence) &&
        !negatedIdentityLine(sentence),
    );
  const entryStageIdentity = identitySentences.some((sentence) =>
    /(?:participate|to\s+enter|before\s+(?:any\s+work|submitting|building)|to\s+submit|sign\s*up|register)/i.test(
      sentence,
    ),
  );
  // Only sentences that actually state a requirement take part in the
  // staging test; fragments split off a longer sentence (an abbreviation
  // like "U.S." ends a "sentence" early) carry no stage of their own.
  const requirementSentences = identitySentences.filter((sentence) =>
    /(?:required|must|shall|will\s+verify|may\s+be\s+required|need\s+to)/i.test(
      sentence,
    ),
  );
  const prizeStageIdentity =
    !entryStageIdentity &&
    requirementSentences.length > 0 &&
    requirementSentences.every((sentence) =>
      /(?:winner|before\s+receiving|prize|payout|payment|awarded)/i.test(
        sentence,
      ),
    );
  if (identity.length > 0) {
    checks.push({
      id: "identity",
      name: "Identity check",
      status: prizeStageIdentity ? "caution" : "fail",
      summary: prizeStageIdentity
        ? "Identity or tax wording is present, and the quoted wording ties it to winning, prize, or payment rather than to building or submitting. Record it as a prize-stage step, not an entry-stage surprise."
        : "Identity verification, tax documentation, or a similar requirement appears in the terms without a clear prize-stage limit in the quoted text.",
      evidence: identity,
    });
  } else if (explicitlyNoIdentity) {
    checks.push({
      id: "identity",
      name: "Identity check",
      status: "pass",
      summary:
        "The posting explicitly says identity verification is not required, in the quoted line.",
      evidence: identityAll,
    });
  } else {
    const noIdentity = firstEvidence(
      text,
      /(?:no\s+(?:KYC|registration|account)\s+(?:is\s+)?required|no\s+purchase\s+necessary|never\s+asks?\s+for\s+keys)/i,
      source,
    );
    checks.push({
      id: "identity",
      name: "Identity check",
      status: noIdentity ? "pass" : "unknown",
      summary: noIdentity
        ? "The posting explicitly removes at least one identity or account requirement in the quoted line."
        : "No identity wording was found in the supplied text. Absence in an excerpt is not a promise that a later stage has none.",
      evidence: noIdentity ? [noIdentity] : [],
    });
  }

  const discretion = findEvidence(
    text,
    /(?:may\s+(?:choose\s+)?not\s+(?:to\s+)?award|no\s+obligation\s+to\s+award|not\s+obligated\s+to\s+award|sole\s+discretion|at\s+(?:our|the\s+sponsor'?s)\s+discretion|reserve\s+the\s+right\s+(?:not\s+to|to\s+cancel))/i,
    source,
  );
  checks.push({
    id: "discretion",
    name: "Sponsor discretion check",
    status: discretion.length > 0 ? "caution" : "pass",
    summary: discretion.length > 0
      ? "The terms reserve discretion that can leave good work unpaid, including a may-not-award or sole-discretion clause."
      : "No may-not-award or sole-discretion clause was found in the supplied text.",
    evidence: discretion,
  });

  const exclusionHits = profile.exclusions.flatMap((exclusion) =>
    findEvidence(text, new RegExp(exclusion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), source, 1)
      .map((item) => ({ exclusion, ...item })),
  );
  const skillHits = profile.skills.filter((skill) =>
    new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text),
  );
  if (exclusionHits.length > 0) {
    checks.push({
      id: "fit",
      name: "Fit check",
      status: "fail",
      summary: `The posting matches saved exclusions: ${[...new Set(exclusionHits.map((hit) => hit.exclusion))].join(", ")}.`,
      evidence: exclusionHits.map(({ quote, source: evidenceSource }) => ({ quote, source: evidenceSource })),
    });
  } else if (skillHits.length > 0) {
    checks.push({
      id: "fit",
      name: "Fit check",
      status: "pass",
      summary: `The posting text matches saved skills: ${skillHits.join(", ")}. No saved exclusion was found.`,
      evidence: [],
    });
  } else {
    checks.push({
      id: "fit",
      name: "Fit check",
      status: "unknown",
      summary: "No saved skill or exclusion matched the posting text, so fit stays unverified rather than assumed.",
      evidence: [],
    });
  }

  const failReasons = checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.name}: ${check.summary}`);
  const cautionReasons = checks
    .filter((check) => check.status === "caution")
    .map((check) => `${check.name}: ${check.summary}`);
  const unknownReasons = checks
    .filter((check) => check.status === "unknown")
    .map((check) => `${check.name}: ${check.summary}`);
  const verdict = failReasons.length > 0
    ? "NO-GO"
    : cautionReasons.length > 0 || unknownReasons.length > 0
      ? "CAUTION"
      : "GO";
  const verdictReasons = verdict === "NO-GO"
    ? failReasons
    : verdict === "CAUTION"
      ? [...cautionReasons, ...unknownReasons]
      : ["Every check that could run passed on the supplied text, with evidence quoted on the card."];

  return {
    title: inferTitle(text, args.title),
    terms,
    checks,
    verdict,
    verdictReasons,
  };
}

export interface ClaimStep {
  label: string;
  detail: string;
  evidence: string | null;
}

export function buildClaimChecklist(args: {
  title: string;
  terms: ExtractedTerms;
  verdict: "GO" | "CAUTION" | "NO-GO";
}): ClaimStep[] {
  const steps: ClaimStep[] = [];
  if (args.verdict === "NO-GO") {
    steps.push({
      label: "Hold",
      detail:
        "Do not start build work on this posting unless the failing check changes or you override the verdict with a written reason.",
      evidence: null,
    });
  }
  steps.push({
    label: "Deadline",
    detail: args.terms.deadlineText
      ? "Put the deadline on the calendar before starting, exactly as the posting states it in the quoted line."
      : "Find and record the exact deadline before starting; it was not extracted from the supplied text.",
    evidence: args.terms.deadlineText,
  });
  steps.push({
    label: "Deliverable",
    detail: args.terms.deliverableText
      ? "Build only the deliverable the posting asks for, in the form the quoted line describes."
      : "Write down the exact deliverable from the posting before starting; it was not extracted from the supplied text.",
    evidence: args.terms.deliverableText,
  });
  steps.push({
    label: "Claim route",
    detail: args.terms.claimRouteText
      ? "Claim through the route the posting itself states, quoted here."
      : "Find the exact claim route before finishing; it was not extracted from the supplied text.",
    evidence: args.terms.claimRouteText,
  });
  steps.push({
    label: "Evidence pack",
    detail:
      "Save the public deliverable link, the evidence for any live run, and the payout address or account the posting asks for, in one claim note.",
    evidence: null,
  });
  steps.push({
    label: "Recheck on claim day",
    detail:
      "Recheck the posting on the day you claim; fill status and terms can change after the first evaluation.",
    evidence: null,
  });
  return steps;
}
