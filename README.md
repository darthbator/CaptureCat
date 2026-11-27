1. Prepare the server

- A Linux machine with Docker Engine and the Compose plugin (docker compose version should work).
- DNS: point your domain's A/AAAA record at the server.
- Firewall/router: open 80 and 443 (HTTPS; 80 is needed to get the certificate) and 1935 (RTMP from OBS). Optionally open 8890/udp (SRT) and 8889 + 8189/udp (WHIP).
- Make sure there's enough disk for video. Docker volumes live under /var/lib/docker by default.

2. Get the code and configure it

git clone https://github.com/darthbator/CaptureCat.git
cd CaptureCat
cp infra/.env.example infra/.env
Edit infra/.env:
DOMAIN=capturecat.example.com
POSTGRES_PASSWORD=<openssl rand -base64 36>
BETTER_AUTH_SECRET=<openssl rand -base64 36>
MEDIAMTX_SECRET=<openssl rand -hex 24>     # hex: it goes into a URL
GOOGLE_CLIENT_ID=...                       # at least one OAuth provider,
GOOGLE_CLIENT_SECRET=...                   # with callback https://<domain>/api/auth/callback/google
Production has no dev login, so you need at least one OAuth provider to sign in at all.

3. Build and start

Run from the repo root:
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
The first build takes a few minutes (it installs dependencies, builds the web app, and installs ffmpeg). Then check:
docker compose -f infra/docker-compose.yml --env-file infra/.env ps
docker compose -f infra/docker-compose.yml --env-file infra/.env logs -f api worker mediamtx caddy
curl https://<domain>/api/health        # → {"ok":true}
Caddy gets the HTTPS certificate automatically on first start. Database migrations run when the API starts.

4. Make yourself admin

Sign in once through the site, then:
docker compose -f infra/docker-compose.yml --env-file infra/.env exec postgres \
  psql -U capturecat capturecat -c "update \"user\" set role='admin' where email='you@example.com';"

5. Stream

In the app, open Go live and generate a stream key. In OBS, use server rtmp://<domain>:1935/live and the key shown on that page.
