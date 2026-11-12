// The three Verdict Desk case studies, copied verbatim from the
// Builder.io build (actions/seed-case-studies.ts). They are
// reconstructed from real cases seen in the week the desk was built,
// with sponsor names, links, and tickers changed, so the demo never
// calls out a named sponsor. The structure of the evidence — the
// wording patterns the checks read — is preserved. Every surface that
// shows them labels them as reconstructed or illustrative.

export interface CaseStudy {
  id: string;
  title: string;
  sourceLabel: string;
  text: string;
  relatedText?: string;
  relatedLabel?: string;
}

export const CONFLICT_POSTING = `Build bounties: $525 in USDC for four agent-framework integrations with our data API.

We want our API to be easy to reach from the agent frameworks people already use. This is one round of four bounties, $525 in total, paid in USDC on Base. The round closes at 11:59 PM Central on 31 December 2026.

The bounty depends on the order in which claims pass our check, not on the framework: the first claim to pass is paid $150, and each of the next three is paid $125.

To claim, email your public repository link and your payout address to our partnerships inbox. The organiser pays winners personally, from his own exchange account, in USDC on Base, within 3 days of a claim passing the check.`;

export const CONFLICT_RESULTS = `Four integrations passed our build bounty.

Each framework slot pays once, to the earliest passing claim. All four bounties have been paid in USDC on Base, by the organiser from his own account, on 27 October 2026.

The round closes at 11:59 PM Central on 31 December 2026, and all four slots are awarded, so a new claim cannot earn a bounty unless a slot reopens.`;

export const OFFERS_POSTING = `Builder offers.

Build a signal context tool for our market data API: a small client that reads the current issue of our signal feed and reduces it to plain regime labels a trading agent can act on.

Award: 100 USDC, one award. Deadline: 30 November 2026, 23:59 UTC. To claim, email your repository link to our hello inbox. Payment is made in USDC on Base to a wallet the winner names.

We may choose not to award if no submission meets the bar. No account or identity verification is required to build or to claim.`;

export const SAMPLE_POSTING = `Sample posting (illustrative, written for this demo — not a real offer).

Build a public data scraper for our community hub and publish the code.
Prize: 500 $HUB, paid in our HUB token to your wallet after judging.
To participate you must complete KYC identity verification and submit a
tax form before any work is reviewed. We may choose not to award the
prize at our sole discretion. Deadline: 20 December 2026.`;

export const CASE_STUDIES: CaseStudy[] = [
  {
    id: "conflict",
    title:
      "Case study (reconstructed): a bounty page its own results post contradicts",
    sourceLabel: "Reconstructed from a real case — names and links changed",
    text: CONFLICT_POSTING,
    relatedText: CONFLICT_RESULTS,
    relatedLabel: "The same sponsor's results post (reconstructed)",
  },
  {
    id: "offers",
    title:
      "Case study (reconstructed): a builder offers page with a may-not-award clause",
    sourceLabel: "Reconstructed from a real case — names and links changed",
    text: OFFERS_POSTING,
  },
  {
    id: "sample",
    title: "Case study: illustrative sample with identity and token flags",
    sourceLabel: "Illustrative sample (not a real offer)",
    text: SAMPLE_POSTING,
  },
];
