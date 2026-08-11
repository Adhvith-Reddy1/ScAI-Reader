# Deploying ScAI-Reader to Fly.io

This guide deploys ScAI-Reader as a **single, always-reachable web app** on
[Fly.io](https://fly.io). No prior server experience needed — just follow the
steps. Everything below is a one-time setup; after that, deploying an update is
a single command.

## What you're deploying

One small cloud machine running the whole app (it serves both the reader and
the API). **It keeps no personal data** — each user's highlights and notes
live only in their own browser; there's no login and no per-user database.

The server does keep a small **content cache** (the uploaded PDF bytes,
rendered page images, and extracted text/search index), keyed by the file's
SHA-256 hash. That cache lives on a persistent Fly volume, so re-opening the
same PDF — even after a deploy or restart — skips re-parsing it from scratch.
Nothing in that cache is user-specific: two people uploading the same PDF
share the same cached copy.

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
#    Postgres/Redis — we don't use one. Accept the existing Dockerfile and
#    fly.toml when prompted. If it asks about the volume already declared in
#    fly.toml, accept it (or create it manually in step 2).
fly launch --no-deploy

#    `fly launch` may rewrite the `app` name and `primary_region` in fly.toml
#    to match your account/region — that's expected.

# 2. Create the persistent volume for the PDF/render/text cache (skip if
#    fly launch already created one for you — check with `fly volumes list`).
#    Match the region you picked above.
fly volumes create scai_reader_data --region iad --size 1

# 3. Give the server your OpenRouter key (stored encrypted, never in git).
fly secrets set OPENROUTER_API_KEY=sk-or-your-key-here
#    OPENROUTER_MODEL is already set to openrouter/free in fly.toml; override
#    here only if you want a specific model.

# 4. Keep it to a single machine (the volume attaches to one machine).
fly deploy
fly scale count 1
```

When it finishes, `fly open` launches your live app in the browser.

## Updating later

Once auto-deploy is set up (below), pushing to `main` on GitHub deploys
automatically — no manual step needed. To deploy by hand instead (e.g. from a
branch, or before auto-deploy is configured):

```bash
git pull          # get the latest code
fly deploy        # build + ship; zero-downtime rolling deploy
```

## Auto-deploy on push to `main` (GitHub Actions)

`.github/workflows/fly-deploy.yml` runs `fly deploy` automatically on every
push to `main`. One-time setup:

```bash
# Create a deploy-scoped token (narrower than your full `fly auth token`).
fly tokens create deploy -a scai-reader
```

Then in the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**, name it `FLY_API_TOKEN`, and paste the token value.
That's it — the next push to `main` (or a manual run from the Actions tab)
deploys.

Rotate the token (`fly tokens create deploy -a scai-reader` again, update the
secret) if it's ever exposed; revoke old ones with `fly tokens revoke`.

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
- The 1 GB volume adds a small storage bill (well under $1/month at that
  size); use `fly volumes extend` if the cache fills up.
- AI is billed to your OpenRouter account; free models cost $0 within the
  daily/minute caps.

## Notes & gotchas

- **Single machine only.** Don't `fly scale count` above 1: the volume
  attaches to one machine, so a user's requests need to stay on it.
- **No per-user database** by design — highlights/notes never leave the
  browser. If `fly launch` offers to add Postgres, decline; the volume it may
  also offer is the one already declared in `fly.toml` (step 2 above).
- **Large PDFs:** uploads up to 200 MB are allowed by the app; Fly's defaults
  handle this fine.
- Health checks hit `GET /healthz`; if a deploy looks unhealthy, `fly logs`
  shows why.
