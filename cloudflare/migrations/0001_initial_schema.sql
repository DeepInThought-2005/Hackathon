-- AskPool on Cloudflare D1 (SQLite). Mirrors the PostgreSQL schema after
-- Flyway V12, without the legacy-VM compatibility steps.
-- Timestamps are ISO 8601 UTC strings written by the Worker, so they sort as text.

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL UNIQUE CHECK (trim(identity) <> '')
);

CREATE TABLE professor_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE professor_courses (
    user_id INTEGER NOT NULL REFERENCES professor_profiles(user_id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK (title = trim(title) AND length(title) BETWEEN 1 AND 120),
    position INTEGER NOT NULL CHECK (position >= 0),
    archived INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX professor_course_names ON professor_courses (user_id, lower(title)) WHERE NOT archived;
CREATE UNIQUE INDEX professor_course_positions ON professor_courses (user_id, position) WHERE NOT archived;

CREATE TABLE lectures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    join_code TEXT NOT NULL UNIQUE CHECK (length(join_code) = 6),
    title TEXT NOT NULL CHECK (trim(title) <> ''),
    lecture_time TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id),
    course TEXT NOT NULL DEFAULT '',
    course_id TEXT,
    started_at TEXT,
    ended_at TEXT,
    questions_paused INTEGER NOT NULL DEFAULT 0,
    CHECK (ended_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX lectures_owner_time_idx ON lectures (owner_id, lecture_time DESC, id DESC);

CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL CHECK (trim(text) <> ''),
    submitted_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unanswered' CHECK (status IN ('unanswered', 'answered')),
    selected INTEGER NOT NULL DEFAULT 0,
    answered_at TEXT,
    CHECK ((status = 'unanswered' AND answered_at IS NULL) OR (status = 'answered' AND answered_at IS NOT NULL)),
    CHECK (NOT selected OR status = 'unanswered')
);
CREATE INDEX questions_lecture_submitted_at_idx ON questions (lecture_id, submitted_at);
CREATE INDEX questions_author_idx ON questions (author_id);

CREATE TABLE question_votes (
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (question_id, user_id)
);
CREATE TABLE question_reports (
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reported_at TEXT NOT NULL,
    PRIMARY KEY (question_id, user_id)
);
CREATE TABLE question_moderation_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL CHECK (reason IN ('blacklisted_word')),
    created_at TEXT NOT NULL
);
CREATE INDEX question_moderation_warnings_user_lecture_idx ON question_moderation_warnings (user_id, lecture_id, created_at);

CREATE TABLE lecture_memberships (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL
);
CREATE INDEX lecture_memberships_lecture_idx ON lecture_memberships (lecture_id);

CREATE TABLE lecture_history (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    first_visited_at TEXT NOT NULL,
    last_visited_at TEXT NOT NULL,
    PRIMARY KEY (user_id, lecture_id)
);
CREATE INDEX lecture_history_user_recent_idx ON lecture_history (user_id, last_visited_at DESC, lecture_id DESC);
CREATE INDEX lecture_history_lecture_idx ON lecture_history (lecture_id);
