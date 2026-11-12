// The AI layer contract: proposals are only as good as their
// verification. The battery decides what survives.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PROFILE, runCheckBattery } from "../src/checks.ts";
import {
  LocalProposer,
  ModelProposer,
  composeExplanation,
  smallestEditSet,
  verifyModelExplanation,
  verifyProposals,
  type TermProposal,
} from "../src/ai-layer.ts";
import { OFFERS_POSTING, SAMPLE_POSTING } from "../src/samples.ts";

function batteryFor(text: string) {
  return runCheckBattery({
    text,
    sourceLabel: "Posting",
    profile: DEFAULT_PROFILE,
  });
}

test("local proposals on the offers posting all verify against the battery", () => {
  const result = batteryFor(OFFERS_POSTING);
  const proposals = new LocalProposer().propose(OFFERS_POSTING);
  assert.ok(proposals.length >= 4);
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals,
    checks: result.checks,
    source: "local",
  });
  assert.equal(outcome.dropped.length, 0);
  const byField = new Map(outcome.verified.map((v) => [v.field, v]));
  assert.equal(byField.get("paymentRoute")?.backedByCheck, "payout");
  assert.equal(byField.get("awardDiscretion")?.backedByCheck, "discretion");
  assert.equal(byField.get("identityDemand")?.backedByCheck, "identity");
  // The negated line proposes the opposite of a demand, and verifies.
  assert.match(byField.get("identityDemand")?.value ?? "", /no identity step/);
});

test("a proposal with an invented quote is dropped", () => {
  const result = batteryFor(OFFERS_POSTING);
  const fake: TermProposal = {
    field: "fundingClaim",
    value: "states an amount of 9,999 USDC",
    quote: "The prize pool is 9,999 USDC, guaranteed.",
  };
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals: [fake],
    checks: result.checks,
    source: "model",
  });
  assert.equal(outcome.verified.length, 0);
  assert.equal(outcome.dropped.length, 1);
  assert.match(outcome.dropped[0].reason, /verbatim/);
});

test("a proposal whose claim contradicts the battery status is dropped", () => {
  const result = batteryFor(OFFERS_POSTING);
  // Real quote, wrong claim: the sentence says verification is NOT
  // required, so a demand claim must not verify against the PASS.
  const wrong: TermProposal = {
    field: "identityDemand",
    value: "identity or tax step demanded at entry stage",
    quote: "No account or identity verification is required to build or to claim.",
  };
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals: [wrong],
    checks: result.checks,
    source: "model",
  });
  assert.equal(outcome.verified.length, 0);
  assert.equal(outcome.dropped.length, 1);
});

test("a proposal pinned to the wrong sentence is dropped", () => {
  const result = batteryFor(OFFERS_POSTING);
  const misplaced: TermProposal = {
    field: "paymentRoute",
    value: "paid directly to a wallet",
    quote: "Deadline: 30 November 2026, 23:59 UTC.",
  };
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals: [misplaced],
    checks: result.checks,
    source: "model",
  });
  assert.equal(outcome.verified.length, 0);
});

test("the sample posting's entry-stage KYC verifies as an identity demand", () => {
  const result = batteryFor(SAMPLE_POSTING);
  const proposals = new LocalProposer().propose(SAMPLE_POSTING);
  const outcome = verifyProposals({
    text: SAMPLE_POSTING,
    proposals,
    checks: result.checks,
    source: "local",
  });
  const identity = outcome.verified.find((v) => v.field === "identityDemand");
  assert.ok(identity);
  assert.match(identity.value, /entry stage/);
});

test("the composed explanation only restates verified facts", () => {
  const result = batteryFor(OFFERS_POSTING);
  const proposals = new LocalProposer().propose(OFFERS_POSTING);
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals,
    checks: result.checks,
    source: "local",
  });
  const explanation = composeExplanation({
    result,
    verified: outcome.verified,
  });
  assert.match(explanation, /100 USDC/);
  assert.match(explanation, /directly to a wallet/);
  assert.ok(!/escrow/i.test(explanation), "no escrow claim the text never made");
});

test("model explanation verification rejects invented quotes and wrong verdicts", () => {
  const good = verifyModelExplanation({
    draft: 'The desk returned CAUTION. The posting says "We may choose not to award if no submission meets the bar."',
    text: OFFERS_POSTING,
    verdict: "CAUTION",
  });
  assert.ok(good);
  const badQuote = verifyModelExplanation({
    draft: 'The desk returned CAUTION. The posting says "Payment is guaranteed by escrow."',
    text: OFFERS_POSTING,
    verdict: "CAUTION",
  });
  assert.equal(badQuote, null);
  const badVerdict = verifyModelExplanation({
    draft: "The desk returned GO on this posting.",
    text: OFFERS_POSTING,
    verdict: "CAUTION",
  });
  assert.equal(badVerdict, null);
});

test("the smallest edit set is derived from the real non-pass checks", () => {
  const result = batteryFor(OFFERS_POSTING);
  const edits = smallestEditSet(result);
  assert.ok(edits.some((e) => e.startsWith("Sponsor discretion check")));
  assert.ok(edits.some((e) => e.startsWith("Payout check")));
  assert.ok(!edits.some((e) => e.startsWith("Identity check")));
});

test("the model proposer parses defensively and its output still faces verification", async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  field: "awardDiscretion",
                  value: "poster reserves discretion over awarding",
                  quote: "We may choose not to award if no submission meets the bar.",
                },
                { field: "nonsense", value: "x", quote: "y" },
                {
                  field: "fundingClaim",
                  value: "states an amount of 5,000 USDC",
                  quote: "A guaranteed 5,000 USDC prize.",
                },
              ]),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const proposer = new ModelProposer({
    apiKey: "test-key-not-real",
    baseUrl: "https://model.invalid/v1",
    model: "test-model",
    fetchFn: mockFetch as typeof fetch,
  });
  const proposals = await proposer.propose(OFFERS_POSTING);
  assert.equal(proposals.length, 2); // the nonsense field is filtered out
  const result = batteryFor(OFFERS_POSTING);
  const outcome = verifyProposals({
    text: OFFERS_POSTING,
    proposals,
    checks: result.checks,
    source: "model",
  });
  assert.equal(outcome.verified.length, 1);
  assert.equal(outcome.verified[0].field, "awardDiscretion");
  assert.equal(outcome.dropped.length, 1); // the invented quote is dropped
});
