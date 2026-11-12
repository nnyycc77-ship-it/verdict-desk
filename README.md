# Verdict Desk — know before you work

Before anyone spends days on a work posting, a gig listing, or a bounty brief, they should know whether the money behind it is real. Today that proof is buried in prose: who funds the work, how the winner gets paid, and whether the poster can decline to pay at all.

Verdict Desk reads the posting, runs a deterministic check battery over the fetched text, and returns a verdict card — **GO**, **CAUTION**, or **NO-GO** — where every claim is backed by a quoted excerpt of the posting itself, printed under the claim. The first verdict is free. The full evaluation, with the complete check list, the claim checklist, and a recheck after the poster edits the posting, is a paid product, unlocked only when a PayPal order is created, approved, and captured.

The same payment rail can sell other checks; this entry builds it for verdicts.

## How it works

1. **Paste or fetch a posting.** The desk fetches public posting pages (private and internal addresses are refused) or takes pasted text.
2. **The battery decides.** Six deterministic checks — terms, fill status, payout route, identity demands, sponsor discretion, and fit — each return pass, caution, fail, or unknown, with quoted evidence. A check that cannot read its fact returns unknown, never a guess. The verdict is computed from the checks alone.
3. **The AI layer reads.** An AI layer proposes structured terms from loose natural language (payment route, funding claim, identity demand, award discretion), writes the plain language explanation on the card, and groups defects into the smallest edit set. The guard is structural: the layer proposes, the battery verifies every proposal against a verbatim quote and against its own evidence and status, and the layer never sets the verdict. Proposals the battery cannot back are shown as dropped, with reasons.
4. **PayPal is the mechanism.** The full evaluation unlocks only on a captured PayPal order (Orders API: create, approve, capture, with webhook confirmation when a webhook id is configured). If a paid evaluation fails after capture — for example the posting page can no longer be fetched for the fresh full run — the capture is refunded automatically. The poster pays a smaller second order for the recheck; the desk re-runs every check on the edited text and shows the movement.

## Run it

Requirements: Node.js 22.6 or newer. There are no runtime dependencies and nothing to install.

```sh
cp .env.example .env   # fill in your PayPal sandbox app credentials
npm start              # http://localhost:8787
npm test               # the full test suite (29 tests)
```

Without PayPal credentials the server still runs, in a clearly labelled **local stub mode**: a banner says so on every page, stub order ids start with `STUB-`, and the stub checkout page states in plain words that it is not PayPal and no money moves. Stub mode exists for local development of everything around the payment; it never imitates a real PayPal call.

### The live sandbox round trip

With sandbox credentials in the environment (or in `.env`):

```sh
npm run round-trip
```

The script runs a free evaluation, creates a real sandbox order, prints the approve link, waits for you to approve it with a sandbox personal test account, captures, and verifies that the full evaluation unlocked.

## Testing access for judges

- Hosted demo: none. There is no hosted demo; run it locally with the instructions above.
- The demo runs on the PayPal sandbox; no real money moves.
- Sandbox test buyer (a fake PayPal sandbox account with a neutral generated name, safe to publish): **John Doe**, email `sb-hcqwx53807053@personal.example.com`, password: the password is in the testing instructions on the Devpost entry. Use it at the PayPal approval step to buy the full evaluation or a recheck; any PayPal sandbox personal account works at the approval step.
- Or run it locally from this repository with the instructions above; a sandbox app of your own is only needed for the live PayPal flow, and stub mode covers everything else.

## Tools statement

- **PayPal developer platform**: Orders API v2 (create, get, capture, refund), the PayPal JavaScript SDK for the approval buttons, and webhook signature verification for capture confirmation. Sandbox environment only in this build.
- **AI tools**: the AI layer's proposer and explanation jobs are implemented against an OpenAI-compatible chat model endpoint. When `AI_API_KEY` is set, the configured model (`AI_MODEL`, default `gpt-4o-mini`) drafts term proposals with verbatim quotes; the deterministic battery verifies or drops each one, and a model-drafted explanation is accepted only sentence by sentence (quoted spans must be verbatim; the verdict word must match the battery). As shipped and demoed, no model key is configured: proposals come from the local extractor that ships in `src/ai-layer.ts`, explanations are composed from the verified check results, and both are labelled with their source in the app. The verdict is always set by the deterministic battery, never by a model.
- Everything else is Node.js built-ins: `node:http` for the server, `node:test` for the suite.

## What is new, what is reused

This project existed before, as the Verdict Desk entered in the Builder.io Agent-Native Hackathon (November 2026). For the PayPal AI Hackathon it was significantly updated:

| Part | Status in this entry |
| --- | --- |
| PayPal order lifecycle (create, approve, capture, unlock) | New |
| Webhook capture confirmation | New |
| Automatic refund when a paid evaluation fails after capture | New |
| Paid unlock and paid recheck mechanics, receipt view | New |
| AI layer (proposal extraction, explanation, triage edit set) with battery verification | New |
| This public repository packaging and judge run instructions | New |
| Deterministic check battery and verdict card | Reused from the earlier entry |
| Three anonymised case studies (names and links changed) | Reused from the earlier entry |

## Repository layout

- `src/checks.ts` — the deterministic check battery (vendored from the earlier build, with its provenance noted in the file header)
- `src/ai-layer.ts` — proposals, verification, explanation, triage
- `src/paypal.ts` — the sandbox Orders API client, and the labelled local stub
- `src/service.ts` — tiers, orders, capture-gated unlock, refunds, webhook handling
- `src/server.ts` — the storefront, checkout routes, SSRF guard, rate limits
- `src/samples.ts` — the three case studies
- `scripts/round-trip.ts` — the one-command live sandbox round trip
- `test/` — battery, AI layer, PayPal client (mocked), service, and end-to-end HTTP suites

## Licence

MIT — see `LICENSE`.
