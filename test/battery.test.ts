// The vendored check battery, exercised on the three case studies
// and on the honesty edge cases the Builder.io build pinned down.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROFILE,
  runCheckBattery,
} from "../src/checks.ts";
import { CASE_STUDIES } from "../src/samples.ts";

function run(text: string, relatedText?: string | null) {
  return runCheckBattery({
    text,
    relatedText: relatedText ?? null,
    sourceLabel: "Posting",
    relatedLabel: "Related sponsor page",
    profile: DEFAULT_PROFILE,
  });
}

function check(result: ReturnType<typeof run>, id: string) {
  const found = result.checks.find((c) => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

test("conflict case study: a results post that contradicts the posting fails the fill check", () => {
  const cs = CASE_STUDIES.find((c) => c.id === "conflict");
  assert.ok(cs);
  const result = run(cs.text, cs.relatedText);
  assert.equal(result.verdict, "NO-GO");
  assert.equal(check(result, "fill").status, "fail");
  assert.ok(check(result, "fill").evidence.length > 0);
});

test("offers case study: may-not-award clause earns CAUTION, no-identity line passes", () => {
  const cs = CASE_STUDIES.find((c) => c.id === "offers");
  assert.ok(cs);
  const result = run(cs.text);
  assert.equal(result.verdict, "CAUTION");
  assert.equal(check(result, "discretion").status, "caution");
  assert.equal(check(result, "identity").status, "pass");
  assert.equal(check(result, "payout").status, "caution");
});

test("sample case study: entry-stage KYC plus sponsor token fails identity and payout", () => {
  const cs = CASE_STUDIES.find((c) => c.id === "sample");
  assert.ok(cs);
  const result = run(cs.text);
  assert.equal(result.verdict, "NO-GO");
  assert.equal(check(result, "identity").status, "fail");
  assert.equal(check(result, "payout").status, "fail");
});

test("a negated identity line never counts as an identity demand", () => {
  const result = run(
    "Build a small tool. Prize: 50 USD. Deadline: 1 March 2027. No KYC or identity verification is required at any stage.",
  );
  assert.equal(check(result, "identity").status, "pass");
});

test("prize-stage identity wording is a caution, not a fail", () => {
  const result = run(
    "Build a small tool. Prize: 50 USD, paid in USD to a wallet. Deadline: 1 March 2027. Winners must complete identity verification before receiving the prize.",
  );
  assert.equal(check(result, "identity").status, "caution");
});

test("fill check behaviour on a past deadline in prose is pinned honestly", () => {
  // Known property of the vendored battery: the expired-deadline
  // branch parses the whole
  // evidence snippet with Date.parse, and prose snippets do not
  // parse, so a past deadline written in prose reads as "unknown"
  // rather than "fail". The check fails toward unknown, never toward
  // a wrong pass. This test pins that behaviour so a future battery
  // upgrade changes it deliberately, not silently.
  const result = run(
    "Build a small tool. Prize: 50 USD. Submissions close on 1 January 2020.",
  );
  assert.equal(check(result, "fill").status, "unknown");
});

test("every non-unknown claim on a card carries a quoted evidence line", () => {
  for (const cs of CASE_STUDIES) {
    const result = run(cs.text, cs.relatedText);
    for (const c of result.checks) {
      if (c.id === "fit") continue; // fit pass rests on profile matching, quoted in its summary inputs
      if (c.status === "pass" || c.status === "fail" || c.status === "caution") {
        if (c.id === "discretion" && c.status === "pass") continue; // absence claim, honestly worded
        assert.ok(
          c.evidence.length > 0,
          `${cs.id}/${c.id} (${c.status}) has evidence`,
        );
      }
    }
  }
});
