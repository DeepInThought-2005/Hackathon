# AskPool

AskPool is a classroom Q&A app with a React/Vite frontend, a Java 21 Spring Boot API, and PostgreSQL. A signed-in person can use both Student and Professor views. They can create lectures, join a live lecture with its six-character code or link, ask and vote on questions, and review their own history. Lecture management and author details are available only to the lecture's creator.

## Build and deploy

From `backend/`, run `./gradlew.bat test bootJar` on Windows (`./gradlew test bootJar` elsewhere). From `frontend/`, run `npm ci`, `npm run build`, `npm run lint`, and `npm run test:api`.

For the independent server deployment, use [standalone deployment](deploy/standalone/README.md). The separate model-based moderation service has been removed; Java retains its bundled sensitive-word checks. The older scripts and deploy/README.md describe the original university VM and must not be run against this server.

Documentation: [API and permissions](docs/API.md), [database schema](docs/Database_State.md).

Test?
