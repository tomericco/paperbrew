# Onboarding Web Implementation Plan (PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first-run card flow at `/app/welcome` and the redesigned desk at `/app`, using the API from PR 1.

**Architecture:** React (Vite, TypeScript), no new dependencies. Onboarding is one `Onboarding` component holding the step; each card is its own file under `apps/web/src/pages/onboarding/`. Cards reuse the existing Settings logic (schedule, printer pairing) by extracting shared hooks or small components, with no behavior change to Settings. The desk replaces `Library.tsx`'s page layout.

**Tech Stack:** React, TypeScript, existing `styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-24-onboarding-design.md`. **Visual and copy reference:** the prototype at https://claude.ai/artifact/YDcfhbEGYjm7Hu7kwHUoUu (private; the spec's copy and step 3 win over it). The prototype source is committed at `docs/design/onboarding-prototype.html` (open it in a browser; it is a throwaway reference, not code to port).

**Depends on:** PR 1 merged (`paperLook`, `needsOnboarding`, `POST /me/onboarding/complete`, `GET /brew?ids=`, `GET /me/gmail` `starter`, `GET /gmail/connect?from=`, `GET /me/next-issue`, `readingMinutes` on articles).

## Global Constraints
- Phone-first: every screen works at 375px wide with no sideways scroll, touch targets of at least 40px on touch screens, hover styles only under `@media (hover: hover)`. Check new UI at phone width before calling it done.
- Same design language as the product: Fraunces display, Source Serif 4 body, ink `#111` on a warm paper tint, hairline buttons with a 4px radius, red only for errors. Dark mode is not in scope (the app has none today).
- Motion is off under `prefers-reduced-motion`. Every control has a visible keyboard focus state. Switches are real `role="switch"` buttons with an accessible name.
- Copy (verbatim where quoted): Welcome lede ends "Let's set it up in 3 mins."; Schedule heading "When should a new issue get printed?" with the subheader "A weekly magazine on weekends, or a fresh issue every morning."; the Printer notice has no header line: "Scheduled issues only brew while a Mac is connected. You can still brew by hand and download the PDF."
- Cards are skippable; skipping everything leaves a working desk.
- Existing Settings page behavior and URLs do not change. Class names added for the new UI are scoped (prefix `ob-` for onboarding, `desk-` for the desk) so the Library and Settings styles are not affected.
- No web test suite exists: verify with `npm run typecheck` and in the browser (1280 and 375 px) against a mock API; report what could not be checked.

## Review Focus
1. **Gmail OAuth leaves and returns mid-flow.** The page must resume on the Gmail card, showing connected, not restart at Welcome (Task 2).
2. **Starter polling.** It stops on `done`, on a 60 s timeout, and on unmount; it never overlaps itself; a failed request shows a retry, not a spinner forever (Task 3).
3. **Nothing found, or no Gmail.** The first-issue card shows the forwarding address, Check again, and Skip; Check again re-reads `/api/articles` and offers Brew once an article exists (Task 3).
4. **Existing user opens `/app/welcome` directly.** It works; Done calls `POST /me/onboarding/complete`; `/app` is never redirected for them (Task 1).
5. **By-hand brew of a selection that changes mid-flight.** Brewing with `ids` of articles archived meanwhile brews fewer, shows what went in from `x-brew-article-ids`, and archives exactly those (Task 5).

---

## File Structure
- `apps/web/src/pages/onboarding/Onboarding.tsx`: step state, dots, card frame, skip, resume.
- `apps/web/src/pages/onboarding/{Welcome,GmailCard,LookCard,FirstIssueCard,ScheduleCard,PrinterCard,DoneCard}.tsx`
- `apps/web/src/pages/onboarding/MagazinePreview.tsx`: the cover and spread preview, driven by `PaperLook` and `PaperLayout`.
- `apps/web/src/pages/looks.ts`: `PAPER_LOOKS` metadata (name, note, accent) shared by onboarding and Settings.
- `apps/web/src/pages/brewClient.ts`: `downloadBrew(ids?: string[]): Promise<{ filename: string; ids: string[] }>` extracted from `Library.tsx`.
- Modified: `src/App.tsx`, `src/pages/Library.tsx` (the desk), `src/pages/Settings.tsx` and `settings/*` (extract shared hooks only), `src/styles.css`, `apps/web/README.md` or `CLAUDE.md` (flow note).

---

### Task 1: Route, frame, Welcome and Done

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/pages/Library.tsx` (redirect only), `apps/web/src/styles.css`
- Create: `apps/web/src/pages/onboarding/Onboarding.tsx`, `Welcome.tsx`, `DoneCard.tsx`

**Interfaces:**
- Produces:
  - Route `/app/welcome` → `<Onboarding />`.
  - `/app` fetches `/api/me`; when `needsOnboarding` is true it replaces the location with `/app/welcome`.
  - `Onboarding` owns `step` (`'welcome' | 'gmail' | 'look' | 'first' | 'schedule' | 'printer' | 'done'`), persisted in `sessionStorage` key `pb.onboarding.step` (every read and write in try/catch), and a `?gmail=connected|error` query on load forces `'gmail'`. A `Card` frame component with props `{ step?: 1|2|3|4|5; children; footer }` renders "Step n of 5" dots for steps 1 to 5.
  - Every card receives `{ next(): void; back(): void }`. A "Skip setup" text link in the frame goes to Done.
  - Done: a summary of newsletters, look, schedule and printer, then "Open my desk", which POSTs `/api/me/onboarding/complete` and goes to `/app`.

- [ ] **Step 1: Build the routes, `Onboarding`, `Card`, `Welcome` and `DoneCard`.** Welcome has the three beats (Save, Brew, Print) with small line icons and the copy above. Done reads current state from `/api/me`, `/api/me/schedule`, `/api/me/gmail`, `/api/me/print-devices`.
- [ ] **Step 2: Verify.** `npm run typecheck`. In the browser with a mock API: a user with `needsOnboarding: true` landing on `/app` ends on `/app/welcome`; reloading mid-flow keeps the step; `false` stays on `/app`. At 375 px no sideways scroll.
- [ ] **Step 3: Commit** `feat(web): onboarding frame, welcome and done cards`.

### Task 2: Gmail and Look cards

**Files:**
- Create: `apps/web/src/pages/onboarding/GmailCard.tsx`, `LookCard.tsx`, `MagazinePreview.tsx`, `apps/web/src/pages/looks.ts`
- Modify: `apps/web/src/pages/Settings.tsx` (paper section gains the look choice using `looks.ts`; keep layout choice as is)

**Interfaces:**
- Consumes: `GET /api/me/gmail`, `GET /gmail/connect?from=welcome` (a full page navigation to `/api/gmail/connect?from=welcome`), `PUT /api/me/settings { paperLayout, paperLook }`, `GET /api/me` (`address`, `gmailAvailable`).
- Produces: `PAPER_LOOKS: { value: PaperLook; label: string; note: string; accent: string }[]` and `type PaperLook` in `looks.ts`; `<MagazinePreview look layout titles minutes />`.

- [ ] **Step 1: Build.**
  - Gmail card: not connected shows "Connect Gmail" (hidden when `gmailAvailable` is false, with the forwarding address as the only option), the read-only reassurance, and the forwarding address with Copy; connected shows "Connected as <email>. Newsletters that arrive from now on are saved." Button label is "Skip for now" until connected, then "Continue".
  - Look card: Paper (Booklet, Flat A4 with small page icons) and Style (the three looks, each showing "Aa" in its typeface and its accent dot), a live preview, saved on change with `PUT /api/me/settings` (optimistic, an inline error on failure).
- [ ] **Step 2: Verify.** `npm run typecheck`; mock API: choosing a look changes the preview and sends `paperLook`; the OAuth return (`?gmail=connected`) lands on the Gmail card showing connected. 375 px.
- [ ] **Step 3: Commit** `feat(web): gmail and look cards`.

### Task 3: First issue card

**Files:**
- Create: `apps/web/src/pages/onboarding/FirstIssueCard.tsx`, `apps/web/src/pages/brewClient.ts`
- Modify: `apps/web/src/pages/Library.tsx` (use `downloadBrew`), `apps/web/src/pages/onboarding/Onboarding.tsx`

**Interfaces:**
- Consumes: `GET /api/me/gmail` (`starter`), `GET /api/articles`, `GET /api/brew?ids=`.
- Produces: `downloadBrew(ids?: string[])`: fetches `/api/brew` (with `ids` when given), saves the PDF through a temporary link click, returns `{ filename, ids }` from the `content-disposition` filename and `x-brew-article-ids`; throws an `Error` whose message is the API's `error` or "Brewing failed." Library keeps its current behavior using it.

- [ ] **Step 1: Build the card.** States:
  - Gmail connected and `starter.state === 'pending'`: "Looking in your inbox…", polling `/api/me/gmail` every 2 s, stopping on `done`, after 60 s, and on unmount; one request in flight at a time; a failed poll shows "Couldn't check your inbox" with Try again.
  - Found articles (from `/api/articles`, at most 3 shown): the list (title, source, minutes), "Brew these" (calls `downloadBrew(ids)` with a brewing progress state, then "Your magazine is ready" with the preview, Download again, and Continue). Do not archive anything here.
  - None found, or Gmail not connected: "Nothing to brew yet", one sentence on how articles arrive, the forwarding address with Copy, "Check again" (re-reads `/api/articles`; any article switches to the found state), and "Skip for now".
- [ ] **Step 2: Verify.** `npm run typecheck`; mock API for: pending then done with 3, done with 0, not connected, a failing poll, brew failure; leaving the card stops polling (no further requests in the network log). 375 px.
- [ ] **Step 3: Commit** `feat(web): first issue card`.

### Task 4: Schedule and Printer cards

**Files:**
- Create: `apps/web/src/pages/onboarding/ScheduleCard.tsx`, `PrinterCard.tsx`
- Modify: `apps/web/src/pages/settings/ScheduleSection.tsx`, `apps/web/src/pages/settings/PrinterSection.tsx` (extract the data and pairing logic into hooks, for example `useSchedule()` and `usePairing()`, used by both the Settings sections and the cards; Settings output unchanged)

**Interfaces:**
- Consumes: `GET/PUT /api/me/schedule` and `/api/me/settings` (`brewEnabled`, `brewDays`, `brewHour`, `brewTimezone`, `brewBudgetMinutes`), `GET /api/me/print-devices`, `POST /api/me/print-devices/pair-code`, `me.macAppUrl`, `me.scheduleAvailable`.
- Produces: the two cards.

- [ ] **Step 1: Build.**
  - Schedule card: heading and subheader exactly as in Global Constraints; day chips, time select, minutes slider (15 to 120, step 5), the live "Your next paper" callout from `/api/me/schedule`'s `nextBrewAt`, and "I'll brew by hand" (saves `brewEnabled: false`, goes next). When `scheduleAvailable` is false the card is skipped automatically.
  - Printer card: "Download for Mac" (hidden when `macAppUrl` is null), "Connect this Mac" (existing pair-code flow, waiting state, then "Your Mac is ready: <name>"), the headerless notice when the schedule is on and no Mac is paired, and "Do this later" or Continue.
- [ ] **Step 2: Verify.** `npm run typecheck`; Settings still renders and behaves the same (open Schedule and Printer there against the mock); cards at 375 px; the notice text matches the constraint exactly and has no heading.
- [ ] **Step 3: Commit** `feat(web): schedule and printer cards`.

### Task 5: The desk

**Files:**
- Modify: `apps/web/src/pages/Library.tsx` (page layout becomes the desk; keep archive access), `apps/web/src/Layout.tsx` (nav: Desk, Issues, Settings where Issues is the existing issues/archive view), `apps/web/src/styles.css`
- Reuse: `downloadBrew`, `BrewedDialog`

**Interfaces:**
- Consumes: `GET /api/me`, `/api/articles`, `/api/me/schedule`, `/api/me/next-issue`, `/api/me/print-devices`, `/api/me/gmail`, `PUT /api/me/settings`, `GET /api/brew?ids=`, `POST /api/articles/archive`.

- [ ] **Step 1: Build.**
  - Top card (states from the spec): scheduled with a Mac ("Prints in N days" and day/time from `nextBrewAt`, the issue's articles and minutes from `/api/me/next-issue`, "Brew now instead"); scheduled without a Mac ("Paused", "Waiting for a Mac", Connect a Mac to Settings); by hand ("Ready when you are", Brew now) and the empty versions.
  - A real switch "On a schedule / By hand" calling `PUT /api/me/settings { brewEnabled }` (turning on with no days set sends `brewDays: [0]`, Sunday, so the schedule is valid).
  - Pile: by hand, a checkbox per article (default: all selected) and "Brew now" brews `downloadBrew(selectedIds)`, then the existing archive dialog for exactly the ids that went in; on a schedule, rows show "In issue" for ids in `/api/me/next-issue` and "Next time" otherwise, oldest first. Remove per article keeps the existing behavior. Empty state shows the forwarding address with Copy.
  - Side rail: Newsletters, Schedule, Printer, Look rows with a status and a Change link into the matching Settings section.
- [ ] **Step 2: Verify.** `npm run typecheck`; mock API for: by hand empty and filled, scheduled with and without a Mac, brew with a selection, archive dialog, switch toggling; the existing Library behaviors you touched still work (archive list, remove, brew error). 1280 and 375 px, no sideways scroll, targets at least 40px.
- [ ] **Step 3: Commit** `feat(web): the desk for manual and scheduled brewing`.

### Task 6: Docs and final pass

**Files:**
- Modify: `CLAUDE.md` (v1 scope and next tasks: onboarding done, the flow, `needsOnboarding`), `apps/web/README.md` if it lists pages

- [ ] **Step 1: Update docs.** One short section on the first-run flow, the desk, and the new API calls.
- [ ] **Step 2: Run** `npm test`, `npm run typecheck`, `npm run build -w @paperbrew/web`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: onboarding flow and desk`.
