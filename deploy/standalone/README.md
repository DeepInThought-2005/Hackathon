# Standalone AskPool on thomas-hub.com

Local source: D:\Hackathon. Original upstream GitHub repository is unchanged.

Services: Caddy static frontend, Java 21 API, PostgreSQL 17. Only Caddy publishes 127.0.0.1:8092; Apache provides public HTTPS. The database uses a persistent Docker volume. Container memory and logs are limited.

## Identity

This deployment deliberately requires no school sign-in. Every browser receives a random guest identity in an HMAC-SHA256 signed, HttpOnly, Secure, SameSite=Lax cookie, valid for 180 days. The persistent signing secret is generated on the server and retained in its private .env. Forged identity headers are stripped at Caddy and replaced in Java. State-changing API requests must use the configured same-origin Origin header.

Guests may use both Student and Professor views, create their own lectures, and manage only their own content under the existing permissions. These are unverified visitors, not verified students or professors. Clearing cookies, using another browser/device, or cookie expiry creates a new guest and loses access to the previous guest's management/history. There is no recovery, identity verification, or device synchronization.

## Moderation

The separate model service and its deployment files are removed. Java retains its bundled sensitive-word list at backend/src/main/resources/moderation/blocked-words.txt. MODERATION_URL is empty. Do not delete the Java resources.

## Build

From backend: .\gradlew.bat test bootJar --no-daemon
From frontend: npm ci --no-audit --no-fund; npm run build; npm run lint; npm run test:api

Copy the executable JAR to artifacts/backend.jar and frontend/dist contents to artifacts/frontend/. Copy compose.yaml, Caddyfile and artifacts/ to /opt/askpool. Create a private .env from .env.example, using independently generated random database and guest-signing secrets. Do not commit or print .env.

On the server: docker compose -p askpool up -d

The old deploy scripts and deploy/README.md describe the university VM; do not run them for this server. This installation starts a new database and does not import university records. No OIDC provider or client credentials are required.

## Domain and HTTPS

Add askpool.thomas-hub.com A -> 94.130.169.139. Activate the Apache virtual host and obtain a certificate after DNS resolves. Production APP_ORIGIN must be https://askpool.thomas-hub.com. Secure guest cookies require HTTPS in a browser.
