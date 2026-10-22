# AskPool deployment result — 2026-10-22

- URL: https://askpool.thomas-hub.com
- Upstream source commit: 26d74605086a356218cb3f7fe97fced132f35c11
- Local modified source: D:\Hackathon (not pushed to GitHub)
- Server deployment: /opt/askpool; Compose project askpool
- Containers: Caddy, Java 21 API, PostgreSQL 17. PostgreSQL data: Docker volume askpool_postgres-data.
- Public ingress: Apache HTTPS -> 127.0.0.1:8092. Backend and PostgreSQL have no published ports.
- Independent moderation folder and scripts deleted. Java's bundled sensitive-word filtering retained and verified.
- No school verification or OIDC. Each browser uses its own signed guest cookie for 180 days. Clearing cookies, changing browser/device or expiry loses access to that guest's history and ownership; this does not establish student status.
- Server .env contains private database and guest signing secrets. Keep the guest secret stable across deployments. Do not disclose or commit it.
- Tests: 84 backend tests passed; frontend build/lint and 15 API tests passed.
- Live API workflow passed: separate guests, persistent identity, identity-header spoof prevention, secure cookie flags, cross-origin write rejection, create/start/join/submit, sensitive-word rejection, end, ownership checks and delete. Temporary validation lectures removed.
- TLS certificate issued by Let's Encrypt, expires 2027-01-20; Certbot renewal scheduled. HTTP redirects to HTTPS except the ACME challenge route.
- Public HTTPS returned 200 from this computer with the correct hostname and certificate validation. Public DNS 1.1.1.1 resolves to 94.130.169.139. The in-app browser still had a negative DNS result during verification, so visual UI verification was not completed there.

See deploy/standalone/README.md for operation and deployment configuration.
