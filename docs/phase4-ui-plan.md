# Phase 4 UI plan: CopilotKit generative UI for "Approved = Paid"

Status (Nov 2, 2026): **built**, except the CopilotKit packages themselves (see section 4 "As built"). Backend gaps (section 5) closed earlier the same day. `apps/web` now has `/deals`, `/deals/:dealId` (+ the PayPal fund return route), every card in section 3, the "Try the demo" button, and a deal copilot panel that renders the cards from actions with an offline replay. `contracts/schemas/deal.schema.json` holds the shared types. See PROGRESS.md for commits.

Motto on every screen: **AI checks facts, people own taste, the deal decides the money.**

## 1. Principles for the UI

1. **Cards are the product.** Every agent answer that touches a deal renders as a card, never as a paragraph about money. The same card components render on the plain deal page (no LLM needed), so the demo works with the model down and judges can click without typing.
2. **The copilot never moves money.** CopilotKit actions only *render* cards and *read* deal state. Every button inside a card calls an existing human route (approve, request changes, accept split, accept change order, one-tap release). The Money Agent then acts through the policy engine. No frontend tool calls `/tick` with an amount, and no route takes an amount for a capture.
3. **Amounts come from the deal, not the chat.** Cards show `amountMinor` from the deal doc and the ledger only. A number the model writes in prose is never bound to a button.
4. **Identity-blind context.** What the copilot is given (`useCopilotReadable`) is the redacted deal view: roles ("Client", "Editor", "Payee 2"), not names, emails or countries, matching `identity.py` on the Python side.
5. **yv. DESIGN.md, no new palette.** Warm canvas `#F7F5F2`, white `.card` surfaces with hairline `line` borders and `shadow-card`, ink `#171310` text, one teal `#035E5E` primary per card, JetBrains Mono `.micro-label`s (HELD, CAPTURED, VERSION, RULE), Outfit `.t-num` for money. Feedback colours only as text or 10% tints (`chip-danger`, `bg-success/10`). Deal states map onto the existing seven-stage palette (below), added to `STAGE_OF` in `components/status.tsx`, not styled ad hoc. Every async card has a skeleton, an empty state that says what to do next, and an error with retry (`states.tsx`). Reduced motion respected.

### Deal state -> existing stage palette
| Milestone state | Stage (fg/bg) |
|---|---|
| DRAFT, SIGNED | idea / brief |
| FUNDED, STYLE_SAMPLE, CHANGES_REQUESTED | production |
| SUBMITTED, CHECKS, IN_REVIEW | review |
| APPROVED, AUTO_APPROVED, CAPTURED | scheduled (teal) |
| PAID_OUT | live |
| DISPUTED, KILLED | failed (danger tint) for DISPUTED; neutral for KILLED |
| CANCELLED | neutral |

## 2. Where it lives in `apps/web`

| New | Path | Notes |
|---|---|---|
| Deals list | `src/pages/DealsPage.tsx`, route `/deals` inside `AppShell` | Nav item next to Contracts / Invoices |
| Deal page | `src/pages/DealPage.tsx`, route `/deals/:dealId` | Left: milestone cards. Right: copilot sidebar (`CopilotSidebar`), collapsible, closed on mobile |
| Fund return | route `/deals/:dealId/fund/:key` | PayPal return URL already used by the service (`?paypal=approved|cancelled`); shows "hold placed" and calls `fund/confirm` |
| Cards | `src/components/deals/*.tsx` | One file per card, below |
| Data | `src/lib/deals.ts` | React Query hooks over the routes below; `src/services/api.ts` gets typed calls |
| Copilot wiring | `src/lib/copilot.tsx` | `<CopilotKit runtimeUrl="/api/v1/copilotkit">` provider, readables, actions |
| Types | reuse `apps/api/src/modules/deals/lib/types.cts` shapes via the `contracts` package (add `deal.schema.json`), so web and API agree |

Existing building blocks to reuse: `PageHeader`, `SectionHeading`, `Avatar` (`components/ui.tsx`); `StatusChip`, `StatusDot`, `stageOf` (`status.tsx`); `Chip`, `Modal`, `EmptyState` (`primitives.tsx`); `Skeleton`, `CardSkeleton`, `ErrorBanner` (`states.tsx`); `useToast`; `money()` formatter from `InvoicesPage`; chart `TEAL`/`RAMP` for the timeline bar.

## 3. Components (generative-UI cards)

Each card is a plain React component taking `{ deal, milestoneKey }` (or the agent proposal it renders). The copilot action of the same name renders it inline in chat; the deal page renders it directly.

| Card | Shows | Buttons (human routes) | Data source |
|---|---|---|---|
| **DealCard** | Title, both parties by role, terms hash (short, mono) + "signed by both" ticks, per milestone: amount, due + grace, review window, rounds left, kill fee %, state chip | Sign (shows the exact terms hash being signed), Fund with PayPal (opens `approveUrl`) | `GET /deals/:dealId` (`view()` adds `me`, `termsHashNow`, `problems`); `POST /deals/:dealId/sign`; `POST /deals/:dealId/milestones/:key/fund` |
| **LiveChecksCard** | Latest version id + sha (mono), one row per checklist line: measured value vs target, pass/fail chip, evidence timestamps with screenshot thumbnails, "unmeasured" rows called out; Taste lines shown as "people decide" | Approve this version (teal), Request changes (opens ReviewMergeCard) | `deal.milestones[].versions[-1].checks` (`results`, `failed`, `unmeasured`, `notes`) written by the Video QA agent via `/internal/deals/:id/milestones/:key/checks`; screenshots served from the agent's evidence dir (needs a static route, see gaps) |
| **ReviewMergeCard** | Reviewer comments merged into items, each tagged **Fix** (cites a failed checklist line) or **Taste** (costs a round, never pay); contradictions between reviewers flagged; "downgraded to Taste" items explained; rounds left after this | Send changes (client) | Review Agent proposal -> `POST /deals/:dealId/policy-check` `{kind:'request_changes'}` returns `items`, `downgraded`, `costsRevisionRound`, `roundsLeftAfter`; send = `POST .../milestones/:key/changes` |
| **MoneyTimeline** | Hash-chained ledger as a vertical timeline: held, reauthorized, captured, partial capture, voided, payout, invoice, **blocked** (rule id chip, e.g. `P3_amount`, + plain explanation, "No money moved"), webhook confirmations; header totals HELD / CAPTURED / PAID OUT; chain-verified badge | One-tap release for pending approvals (above-threshold capture, refunds) | `GET /deals/:dealId/ledger` (`entries`, `chain`, `totals`); `deal.pendingApprovals`; `POST /deals/:dealId/approvals/:approvalKey` |
| **ChangeOrderCard** | The out-of-scope ask quoted, the rate-card line, qty x unit = price (all from the signed rate card), what it unlocks (one extra round) | Accept (client, teal) / Decline; after accept shows the PayPal invoice id | `deal.changeOrders`; `POST /deals/:dealId/change-orders` (draft); `POST /deals/:dealId/change-orders/:coId/accept|decline` |
| **DisputeSplitCard** | Evidence pack (checks, change requests, rounds used), proposed split from checklist arithmetic (e.g. 4 of 5 lines met -> 80%), each side's accepted number, "agreed" only when both match | Accept this split (each party), Open dispute | Scope & Dispute Agent proposal dry-run via `policy-check` (`assumed` shows "both sides accept this split"); `POST .../milestones/:key/dispute`; `POST .../milestones/:key/split` `{workerMinor}`; the Money Agent captures on the next tick |
| **PolicyBlockedChip** (shared) | Rule id + one-line message from a blocked decision | none | any `violations[]` |

## 4. CopilotKit wiring

- **Frontend:** `@copilotkit/react-core` + `@copilotkit/react-ui` (pin the current 1.x at build time and confirm the hook names against its docs; recent releases add `useFrontendTool` / `useRenderToolCall` alongside `useCopilotAction`).
  - Readables: the redacted deal view of the open deal, and the user's role on it.
  - Render-only actions: `showDeal`, `showChecks`, `showReviewMerge`, `showMoneyTimeline`, `showChangeOrder`, `showDisputeSplit`. Parameters are ids only (`dealId`, `milestoneKey`, `changeOrderId`); the card fetches its own data. No action takes an amount.
  - Proposal actions (`proposeChanges`, `proposeChangeOrder`, `proposeSplit`) call the agent, which dry-runs through `policy-check` and returns the decision; the card shows it with the human button. Blocked proposals render the PolicyBlockedChip, not a button.
- **Runtime:** `@copilotkit/runtime` mounted in the API at `POST /api/v1/copilotkit` behind `authenticate` + org access, with an OpenAI-compatible adapter pointed at River (fallback NIM) so keys stay server-side; or, if the Python side is preferred, the CopilotKit Python SDK on `services/agent` reusing `llm_router.py` (River -> NIM, disk cache, identity assert). Decision at build time: prefer the Python route if it keeps one LLM path and the offline replay cache; prefer Node if it is materially simpler.
- **Offline / judge mode:** with `LLM_OFFLINE=1` or no key, the sidebar shows suggested prompts that map straight to render actions (no model call), so every card is still reachable.

### As built (Nov 2, 2026)

- **Decision: no CopilotKit packages yet.** `@copilotkit/react-core` 1.83 pulls lit, katex, recharts, streamdown, radix, a web inspector and a `maplibre-gl` peer into the web bundle; `@copilotkit/runtime` 1.83 pulls about 40 packages into the API (graphql-yoga, type-graphql, the AI SDK with Google/Vertex/Anthropic providers, langgraph, MCP SDK, Segment analytics, a license verifier). The API job gates on `npm audit --omit=dev --audit-level=high`, so each of those transitive packages becomes a CI risk; the bundled Google/Vertex providers are code we would never call (no Google sign-in LLMs); and the demo has to work with no LLM anyway. Not installed or audited here: this is a judgement from the published dependency lists.
- **What ships instead:** `apps/web/src/lib/copilot.tsx` defines the same actions one to one (`showDeal`, `showChecks`, `showReviewMerge`, `showMoneyTimeline`, `showChangeOrder`, `showDisputeSplit`, `showBlocked`, and `proposeCapture` as a read-only `policy-check` dry-run). Parameters are ids only; a typed number is used only in a dry-run and labelled as the person's. `components/deals/DealCopilot.tsx` renders the cards inline. The default path is the **offline replay**: suggested prompts and typed questions are matched deterministically, no model call. Moving to CopilotKit later means registering these actions with `useCopilotAction` / `useRenderToolCall` and mounting a runtime; the cards do not change.
- **LLM path (not wired yet):** when added, it should be one path: `POST /api/v1/organizations/:org/deals/:dealId/copilot` (Node, auth + org access) -> `services/agent` -> `llm_router.py` (River AI -> NVIDIA NIM -> OmniRoute, disk cache, identity assert), returning an action name + ids only, with the offline matcher as the fallback and replay cache.

## 5. Gaps to close before the UI build (all closed Nov 2, 2026)

1. Review Agent output is not stored in Node: add `POST /internal/deals/:id/milestones/:key/review` (deals:propose) storing the merged, dry-run proposal on the milestone, and expose it in the deal view.
2. Check evidence screenshots: serve the agent's evidence frames from a signed static route (or upload to the existing media store) so `LiveChecksCard` thumbnails load.
3. Dispute evidence pack: same pattern as 1 (store the Scope & Dispute proposal).
4. Demo seed script (`apps/api/scripts/seed-deal-demo.cjs`): one org, judge login, one deal per interesting state (in review with a failing check, change order pending, dispute with split proposed, captured + paid out with a blocked attempt on the ledger). Uses the mock gateway unless PayPal sandbox buyer creds exist.
5. One-tap judge login (seeded user + a "Try the demo" button on `/login`).
6. Socket.IO push on ledger append so the timeline updates live (the chat socket already exists; add a `deal:<id>` room).

## 6. Demo flow judges will click

1. **Try the demo** on the login page -> lands on `/deals`, opens "Diwali launch reels" (seeded). DealCard: both sides signed the hash-locked terms; reel 1 is **held** on PayPal (authorization, not a charge).
2. Editor submits v1 -> **LiveChecksCard** fills in: length, hook, logo window, loudness. Loudness fails at -20.1 LUFS with a timestamped screenshot; "feels festive" is marked Taste for people.
3. Client types two notes ("too quiet", "make it more festive") -> **ReviewMergeCard** tags "too quiet" as Fix (cites the failed loudness line) and "more festive" as Taste (costs a revision round, not pay).
4. Client asks for an extra 15s cut -> **ChangeOrderCard** prices it from the signed rate card ($60 x 1); one tap accepts it and a PayPal invoice is drafted.
5. Editor submits v2, every check passes -> client taps **Approve v2** -> **MoneyTimeline**: capture of exactly the signed $400, payouts split 70/30 to the two payees, ledger chain verified.
6. Judge asks the copilot to "capture $450" or "pay the old version" -> the proposal is dry-run and comes back **blocked** with `P3_amount` / `P6_version` on the timeline, "No money moved".
7. Reel 2 goes to **DisputeSplitCard**: 4 of 5 lines met -> proposed 80%; the button stays disabled until both sides accept the same number; then the Money Agent captures 80% and voids the rest.
8. Silence path (optional): fast-forward the clock on the seeded deal; the review window lapses and a version that passed every check auto-captures.

## 7. Out of scope for Phase 4

Star ratings (two-sided factual track records only), any client name from the real case study, Antigravity CLI / Google sign-in for LLMs, card-processing on the sandbox business account (blocked; uses buyer approval instead).
