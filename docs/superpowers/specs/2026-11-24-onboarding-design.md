# Guided onboarding and a desk for manual and scheduled brewers

Status: approved by the user on 2026-11-24 after a clickable prototype (https://claude.ai/artifact/YDcfhbEGYjm7Hu7kwHUoUu, private; it predates the copy and step 3 changes below, which win over it).

## Why
Today sign-in drops a new user on an empty Library with a forwarding address. The three things that make Paperbrew work (a way to save, a schedule, a paired Mac) live in Settings and nothing steers people there. People should be guided and told how it works the minute they sign up, and reach two "aha" moments quickly: a first magazine, then a schedule that prints on its own.

## Goals
- A first-run flow of single cards, minimal, phone-first, every card skippable.
- A desk (the post-setup home) that serves people who brew by hand and people who brew on a schedule.
- Looks (presets) and a paper choice chosen during setup and used by every brew.

## Non-goals
- No inbox backfill beyond the starter fetch of up to 3 articles (user decision: "no need to backfill").
- No paste-a-link endpoint (next task 2 in CLAUDE.md). Where the prototype had one, the forwarding address is shown instead.
- No article view/edit, no Apple signing, no new printing paths. The printer card stays Mac-only.

## The flow (`/app/welcome`)
Dots read "Step n of 5" on cards 2 to 6 below.

0. **Welcome.** "Read what you saved, on paper." Lede ends with "Let's set it up in 3 mins." Three beats: Save, Brew, Print. Button: Get started.
1. **Gmail.** Connect Gmail (OAuth, returns to `/app/welcome?gmail=connected`); once connected the card says so and that newsletters are saved from now on (there are no senders to list yet; per-sender control stays in Settings). Or the forwarding address with Copy. Skip for now.
2. **Look.** Paper (Booklet or Flat A4) and a style: Broadsheet, Field Notes, Zine, with a live cover and spread preview.
3. **First issue** (aha 1). With Gmail connected, the server fetches up to 3 recent editorial newsletters ("Looking in your inbox…"). If it finds some: list them, "Brew these", download the PDF, Continue. If it finds none, or Gmail is not connected: "Nothing to brew yet", the forwarding address with Copy, "Check again", and Skip. Whoever adds an article and checks again gets the Brew step.
4. **Schedule** (aha 2). Heading "When should a new issue get printed?" Subheader gives examples only: "A weekly magazine on weekends, or a fresh issue every morning." Days, time, minutes to read, and a live "Your next paper: Sunday at 8:00 am". Link: "I'll brew by hand".
5. **Printer.** Download for Mac and Connect this Mac (existing pairing). When the schedule is on, a notice without a header: "Scheduled issues only brew while a Mac is connected. You can still brew by hand and download the PDF." Do this later.
6. **Done.** A summary and "Open my desk".

## The desk (`/app`)
- Top card: scheduled and a Mac paired: "Prints in N days / Sunday at 8:00 am", the issue's articles and minutes, "Brew now instead". Scheduled without a Mac: "Paused / Waiting for a Mac" with Connect a Mac. By hand: "Ready when you are" with Brew now; empty pile says so.
- A switch "On a schedule / By hand" toggles `brew_enabled`.
- Reading pile: by hand, tick the articles for the next issue; on a schedule, rows show "In issue / Next time" (the server's pick rule, newest first within the budget). The empty state shows the forwarding address.
- Side rail: setup status for Newsletters, Schedule, Printer, Look, each linking to Settings.
- Nav: Desk, Issues, Settings (the existing pages stay; Library's archive view moves under Issues only if cheap, otherwise stays reachable).
- First run: `/app` redirects to `/app/welcome` while `needsOnboarding`.

## Server changes
- `users.paper_look` (`broadsheet` default, `fieldnotes`, `zine`), applied by the renderer to every brew (web, agent PDF).
- `users.onboarded_at`; `needsOnboarding` is computed: `onboarded_at is null` and no articles, no Gmail connection, no paired Mac, and brew not enabled (so existing users are never redirected).
- `GET /me/next-issue` previews, read-only, what the next scheduled issue would hold (the same pick rule as `createIssue`), so the desk can show "In issue / Next time" without duplicating the rule; `GET /articles` also returns `readingMinutes`.
- `GET /brew?ids=a,b,c` brews only those articles (the user's, ready, not archived, max 50) so manual picks can be brewed.
- Starter fetch: after a Gmail connect a `gmail_starter` job saves up to 3 editorial newsletters from the last 30 days, then records `starter_done_at`. `GET /me/gmail` reports `starter: { state: 'pending' | 'done', saved }`. The OAuth callback accepts a return target of `welcome` or `settings`.

## Approaches considered
1. Value first (first PDF in minutes, automate later) or setup first (finish with a printed issue). Chosen: both, in the user's order: Gmail, look, first issue, schedule, printer.
2. Starter fetch synchronously in the callback, or as a queued job the page polls. Chosen: a job (the callback must redirect fast, Gmail classification is slow); it reuses the existing message pipeline.
3. Edit setup later by re-opening cards, or by Settings. Chosen: Settings (it exists and was just redesigned); onboarding cards are first-run only.

## Calls made by the builder, to confirm
- "Manually brew" in step 3 is read as: add an article (forward an email), Check again, then brew. There is no sample issue.
- Looks are three fixed presets (typeface pairing and accent only); no per-user font or colour pickers.
- Printing without a Mac keeps its current meaning: scheduled brews wait for a paired Mac.

## Not covered by tests
Real Gmail (the starter fetch is tested with mocks), forced-colors, screen readers. Web has no test suite; web work is checked by typecheck and in the browser at 1280 and 375 px.
