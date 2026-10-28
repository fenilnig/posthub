# Post Hub

One local app for Atlas Builders, m33.hq, Legend editx and Fenil Shah. Posts to X, LinkedIn, YouTube and Instagram through their official APIs. Everything (tokens, queue, videos) is stored on your PC in `data.json` and `media/`. Keep `config.json` and `data.json` private.

## Run
Needs Node 18+. Copy `config.example.json` to `config.json`, fill it in, then:

    node server.js

Open http://localhost:3000 on the PC. Connect accounts from the PC only.

## Phone access (data stays on the PC)
1. Set `password` in config.json. Without it, remote access is off.
2. Install Tailscale on the PC and phone, then on the PC: `tailscale funnel 3000` (check Tailscale's docs if the command differs on your version). It gives a stable https link like `https://your-pc.your-tailnet.ts.net`.
3. Put that link in `publicBaseUrl` (Instagram needs it to fetch your video) and open it on your phone. Log in with the password.
Only `/media/` is reachable without the password; everything else needs it. The PC must be on and `node server.js` running, or scheduled posts will not go out.

## Per-platform setup (each needs a free developer app; redirect URI = `http://localhost:3000/cb/<platform>`)
- **X**: developer.x.com, create an app with OAuth 2.0 (confidential client), redirect `http://localhost:3000/cb/x`. Check X's current API pricing for posting, I haven't verified it. Text only.
- **LinkedIn**: linkedin.com/developers, create an app, add "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect", redirect `http://localhost:3000/cb/linkedin`. Personal profile only; Company Pages need LinkedIn approval. Text only.
- **YouTube**: Google Cloud Console, enable YouTube Data API v3, OAuth client (Web), redirect `http://localhost:3000/cb/youtube`. Google keeps uploads from unverified API projects private until the project passes an audit, so videos may arrive as private.
- **Instagram**: developers.facebook.com app using the Instagram API with Instagram Login; the redirect is `<publicBaseUrl>/cb/instagram` (Instagram only accepts https). The account must be Business or Creator, added as an Instagram Tester in the app. Posts: a Reel (one video), one JPEG, or a carousel of 2-10 JPEG photos and/or videos. Instagram downloads each file from `<publicBaseUrl>/media/`, so the PC and the Tailscale funnel must be on. Uploaded videos are converted to H.264/AAC MP4 (needs ffmpeg), PNG/WEBP photos to JPEG.

Failed platforms are never retried automatically, to avoid double posts. Fix the cause and post again.
