# Deploying ScAI-Reader to Fly.io

This guide deploys ScAI-Reader as a **single, always-reachable web app** on
[Fly.io](https://fly.io). No prior server experience needed — just follow the
steps. Everything below is a one-time setup; after that, deploying an update is
a single command.

## What you're deploying

One small cloud machine running the whole app (it serves both the reader and
the API). **It keeps no personal data** — each user's PDFs, highlights, and AI
answers live in their own browser. That's why there's **no disk/volume** to
manage and **no database to back up**. The trade-off we accepted: the server
re-renders a PDF each session (a little slower, much simpler).

AI explanations come from **your** OpenRouter key, using free models, shared by
everyone who visits (no per-user limit for now).

## Prerequisites

1. A [Fly.io account](https://fly.io/app/sign-up) (free to create; a card is
   required to deploy).
2. An [OpenRouter API key](https://openrouter.ai/keys) with at least $10 of
   credit added (this unlocks 1,000 free-model requests/day; the cap is 20/min,
   shared across all users — the app shows a friendly "AI is busy" notice if
   that's hit).
3. The Fly CLI installed:
   ```bash
   # macOS
   brew install flyctl
   # Linux / WSL
   curl -L https://fly.io/install.sh | sh
   ```
4. Log in: `fly auth login`

## First deploy

From the repo root:

```bash
# 1. Create the app on Fly WITHOUT deploying yet. When asked, say NO to
#    Postgres/Redis/any database — we don't use one. Accept the existing
#    Dockerfile and fly.toml when prompted.
fly launch --no-deploy

#    `fly launch` may rewrite the `app` name and `primary_region` in fly.toml
#    to match your account/region — that's expected.

# 2. Give the server your OpenRouter key (stored encrypted, never in git).
fly secrets set OPENROUTER_API_KEY=sk-or-your-key-here
#    OPENROUTER_MODEL is already set to openrouter/free in fly.toml; override
#    here only if you want a specific model.

# 3. Keep it to a single machine (the in-session render cache is per-machine).
fly deploy
fly scale count 1
```

When it finishes, `fly open` launches your live app in the browser.

## Updating later

```bash
git pull          # get the latest code
fly deploy        # build + ship; zero-downtime rolling deploy
```

## Everyday commands

| Task | Command |
|---|---|
| Open the live app | `fly open` |
| Watch logs | `fly logs` |
| Check status / machines | `fly status` |
| Roll back a bad deploy | `fly releases` then `fly deploy --image <previous-image-ref>` |
| Change the AI key | `fly secrets set OPENROUTER_API_KEY=...` (auto-redeploys) |
| Keep it always warm (no cold start) | set `min_machines_running = 1` in `fly.toml`, then `fly deploy` |

## Cost

- The machine is `shared-cpu-1x` / 1 GB. With `min_machines_running = 0`
  (the default here) it **scales to zero when idle**, so you mostly pay only
  while it's in use — typically a few dollars a month for light traffic. The
  first request after idle cold-starts the machine (a few seconds).
- **No volume = no storage bill.**
- AI is billed to your OpenRouter account; free models cost $0 within the
  daily/minute caps.

## Notes & gotchas

- **Single machine only.** Don't `fly scale count` above 1: the ephemeral
  per-session PDF/render cache lives on the machine, so a user's requests need
  to stay on one. (There's no shared data to lose — this is purely about
  in-session rendering.)
- **No database, no volume** by design. If `fly launch` offers to add Postgres
  or a volume, decline.
- **Large PDFs:** uploads up to 200 MB are allowed by the app; Fly's defaults
  handle this fine.
- Health checks hit `GET /healthz`; if a deploy looks unhealthy, `fly logs`
  shows why.
