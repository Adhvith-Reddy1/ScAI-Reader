# Spec 12 — Signup nudge ("why sign in")

**Branch:** `feat/12-signup-nudge` · **Wave:** 3 (Phase 2) · **Depends on:**
Spec 08 (needs the sign-in entry point) **and** Spec 11 (needs sync to
actually exist before the nudge promises it). **Conflicts with:** small
touch to wherever highlights get created (to count them) and to
`frontend/src/main.ts`.

## Goal
Once a reader has made 5 highlights anonymously, show one dismissible nudge
suggesting they sign in — mirroring `AiSetup.ts`'s existing
`maybeShowAiNudge` pattern exactly (same one-time, localStorage-dismissed
shape), so this lands as a small, low-risk addition once Specs 08 and 11
are in place.

## Why this spec waits on Spec 11
A nudge that says "sign in to sync across devices" is only honest once
sync is real. Don't ship the messaging ahead of the feature — a reader who
signs in expecting sync and doesn't get it is worse than no nudge at all.

## Scope
**In:**
- **`frontend/src/SignupNudge.ts`** — `maybeShowSignupNudge(parent)`:
  - Count highlights via a lightweight running counter in localStorage
    (`scai.highlightCount`), incremented at the same call site Spec 09
    instruments for `highlight_created` — piggyback on that touch point
    rather than adding a second one. Don't do a full IndexedDB scan on every
    page load just to count annotations.
  - Trigger once the counter crosses 5. Never show again after dismissal
    (`scai.signupNudgeDismissed`, same pattern as
    `scai.aiNudgeDismissed`) or once the reader is signed in (check
    `getAccountStatus()` from Spec 08 first — a signed-in reader should
    never see this).
  - Copy leads with the concrete, true benefit: "Sign in to keep your
    highlights when you switch devices" — not vague "create an account"
    language. Button opens the same sign-in flow Spec 08's account button
    uses.

**Out:** any additional premium-feature ideas beyond sync (personal stats,
folders, higher AI quota for signed-in readers, etc.) — worth considering
later, but each is its own product decision and its own spec, not bundled
into this one.

## Testing
- Vitest mirroring `AiSetup.test.ts`'s nudge tests: shows once the counter
  crosses 5; dismiss persists across reloads; never shows when already
  signed in; never shows twice.

## Acceptance criteria
- [ ] Nudge appears exactly once, at the 5-highlight mark, for an
      anonymous reader who hasn't dismissed it.
- [ ] Never appears for a signed-in reader.
- [ ] Dismissal persists (localStorage), matching the AI-setup nudge's
      existing UX.
- [ ] Copy only promises what Spec 11 actually delivers.
