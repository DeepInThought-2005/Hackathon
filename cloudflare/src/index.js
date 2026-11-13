// AskPool API on Cloudflare Workers + D1. A port of the Java backend
// (PoolController, PoolService, PoolRepository, ProfessorProfileService and
// GuestIdentityFilter) that keeps the same /api contract as docs/API.md.
// Everything that is not /api/* is the built frontend, served from static assets.
import { blocks } from './moderation.js';

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const BAD_BODY = 'Invalid request body or parameter.';
const now = () => new Date().toISOString();

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

// ---- Guest identity: a signed, HttpOnly cookie per browser (GuestIdentityFilter.java) ----

const COOKIE = 'askpool_guest';
const LIFETIME = 180 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function signer(secret) {
  if (!secret || new TextEncoder().encode(secret).length < 32)
    throw new Error('GUEST_IDENTITY_SECRET must be at least 32 bytes.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async payload => {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function identity(token, sign) {
  if (!token || token.length > 160) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !UUID.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const expires = Number(parts[1]);
  const seconds = Math.floor(Date.now() / 1000);
  if (expires <= seconds || expires > seconds + LIFETIME + 60) return null;
  if (!equal(await sign(`${parts[0]}.${parts[1]}`), parts[2])) return null;
  return `guest:${parts[0]}`;
}

function cookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

async function guest(request, env) {
  const sign = await signer(env.GUEST_IDENTITY_SECRET);
  let id = await identity(cookie(request, COOKIE), sign);
  let setCookie = null;
  if (!id) {
    const payload = `${crypto.randomUUID()}.${Math.floor(Date.now() / 1000) + LIFETIME}`;
    const token = `${payload}.${await sign(payload)}`;
    id = await identity(token, sign);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    setCookie = `${COOKIE}=${token}; Max-Age=${LIFETIME}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }
  return { id, name: `Guest ${id.slice(6, 14)}`, setCookie };
}

// ---- Request helpers ----

async function body(request) {
  try {
    const value = await request.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ApiError(400, BAD_BODY);
  }
}

function longId(value) {
  if (!/^\d{1,15}$/.test(value)) throw new ApiError(400, BAD_BODY);
  return Number(value);
}

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new ApiError(400, `${label} must be 1 to ${max} characters.`);
  return value.trim();
}

function joinCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[0-9A-F]{6}$/.test(code)) throw new ApiError(400, 'Enter a 6-character lecture code (0–9 and A–F).');
  return code;
}

function timestamp(value) {
  // Java's OffsetDateTime requires an explicit offset.
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || Number.isNaN(Date.parse(value)))
    throw new ApiError(400, BAD_BODY);
  return new Date(value).toISOString();
}

// ---- Data access (PoolRepository.java) ----

class Pool {
  constructor(db, user) {
    this.db = db;
    this.user = user;
  }
  first(sql, ...args) { return this.db.prepare(sql).bind(...args).first(); }
  async all(sql, ...args) { return (await this.db.prepare(sql).bind(...args).all()).results; }
  run(sql, ...args) { return this.db.prepare(sql).bind(...args).run(); }

  async access(id) {
    const row = await this.first('SELECT id, owner_id, started_at, ended_at, questions_paused FROM lectures WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'Lecture not found.');
    return row;
  }
  async questionAccess(id) {
    const row = await this.first('SELECT id, lecture_id, author_id FROM questions WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'Question not found.');
    return row;
  }
  async requireManage(lecture) {
    const access = await this.access(lecture);
    if (access.owner_id !== this.user) throw new ApiError(403, 'You do not manage this lecture.');
    return access;
  }
  async lectureIdByCode(code) {
    const row = await this.first('SELECT id FROM lectures WHERE join_code = ?', code);
    if (!row) throw new ApiError(404, 'Lecture code not found.');
    return row.id;
  }

  static LECTURE = `SELECT l.*, c.title AS course_name, COALESCE(c.archived, 0) AS course_archived
    FROM lectures l LEFT JOIN professor_courses c ON c.user_id = l.owner_id AND c.id = l.course_id`;
  lecture(row) {
    return {
      id: String(row.id), joinCode: row.join_code, title: row.title, lectureTime: row.lecture_time,
      canManage: row.owner_id === this.user, course: row.course, startedAt: row.started_at, endedAt: row.ended_at,
      questionsPaused: Boolean(row.questions_paused),
      courseKey: row.course_id == null ? null : `${row.owner_id}:${row.course_id}`,
      courseName: row.course_name, courseArchived: Boolean(row.course_archived),
    };
  }
  async lectureById(id) {
    const row = await this.first(`${Pool.LECTURE} WHERE l.id = ?`, id);
    if (!row) throw new ApiError(404, 'Lecture not found.');
    return this.lecture(row);
  }
  async lectures() {
    const rows = await this.all(`${Pool.LECTURE}
      WHERE l.owner_id = ?1
         OR EXISTS (SELECT 1 FROM lecture_history h WHERE h.user_id = ?1 AND h.lecture_id = l.id)
         OR EXISTS (SELECT 1 FROM lecture_memberships m WHERE m.user_id = ?1 AND m.lecture_id = l.id)
      ORDER BY l.lecture_time DESC, l.id DESC`, this.user);
    return rows.map(row => this.lecture(row));
  }
  async history() {
    const rows = await this.all(`SELECT l.*, c.title AS course_name, COALESCE(c.archived, 0) AS course_archived
      FROM lecture_history h JOIN lectures l ON l.id = h.lecture_id
      LEFT JOIN professor_courses c ON c.user_id = l.owner_id AND c.id = l.course_id
      WHERE h.user_id = ? ORDER BY h.last_visited_at DESC, l.id DESC`, this.user);
    return rows.map(row => this.lecture(row));
  }
  visitStatement(lecture) {
    const at = now();
    return this.db.prepare(`INSERT INTO lecture_history (user_id, lecture_id, first_visited_at, last_visited_at) VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT (user_id, lecture_id) DO UPDATE SET last_visited_at = max(last_visited_at, excluded.last_visited_at)`).bind(this.user, lecture, at);
  }
  recordVisit(lecture) { return this.visitStatement(lecture).run(); }
  async joinedSession() {
    const row = await this.first(`SELECT l.id, l.join_code, l.title, l.course, l.started_at FROM lecture_memberships m
      JOIN lectures l ON l.id = m.lecture_id WHERE m.user_id = ? AND l.started_at IS NOT NULL AND l.ended_at IS NULL`, this.user);
    return row && { id: String(row.id), code: row.join_code, course: row.course.trim() ? row.course : row.title, startedAt: row.started_at };
  }

  // Student-facing reads must never fetch an author's account identity.
  static ORDER = ' ORDER BY (q.status = \'answered\'), votes DESC, q.submitted_at, q.id';
  static PUBLIC_QUESTION = `SELECT q.id, q.text, q.submitted_at, q.status, q.selected, q.author_id = ?1 AS mine,
      (SELECT count(*) FROM question_votes v WHERE v.question_id = q.id) AS votes,
      EXISTS (SELECT 1 FROM question_votes v WHERE v.question_id = q.id AND v.user_id = ?1) AS voted_by_me
    FROM questions q WHERE q.lecture_id = ?2`;
  static status(row) { return row.status === 'answered' ? 'answered' : row.selected ? 'selected' : 'open'; }
  static publicQuestion(row) {
    return { id: String(row.id), text: row.text, votes: row.votes, createdAt: row.submitted_at, status: Pool.status(row),
      mine: Boolean(row.mine), votedByMe: Boolean(row.voted_by_me) };
  }
  async questions(lecture) {
    return (await this.all(Pool.PUBLIC_QUESTION + Pool.ORDER, this.user, lecture)).map(Pool.publicQuestion);
  }
  async question(lecture, id) {
    const row = await this.first(`${Pool.PUBLIC_QUESTION} AND q.id = ?3`, this.user, lecture, id);
    if (!row) throw new ApiError(404, 'Question not found.');
    return Pool.publicQuestion(row);
  }
  async professorQuestions(lecture) {
    const rows = await this.all(`SELECT q.id, q.text, q.submitted_at, q.status, q.selected, q.answered_at, u.identity,
        (SELECT count(*) FROM question_votes v WHERE v.question_id = q.id) AS votes,
        (SELECT count(*) FROM question_reports r WHERE r.question_id = q.id) AS reports
      FROM questions q JOIN lectures l ON l.id = q.lecture_id AND l.owner_id = ?1 JOIN users u ON u.id = q.author_id
      WHERE q.lecture_id = ?2${Pool.ORDER}`, this.user, lecture);
    return rows.map(row => ({
      id: String(row.id), text: row.text, authorId: row.identity, upvoteCount: row.votes, createdAt: row.submitted_at,
      answered: row.status === 'answered', status: Pool.status(row), answeredAt: row.answered_at, reportCount: row.reports,
    }));
  }

  // ---- Service rules (PoolService.java) ----

  async createLecture(request) {
    const time = timestamp(request.lectureTime ?? undefined);
    const title = text(request.title, 200, 'Lecture title');
    let course = request.course == null || (typeof request.course === 'string' && !request.course.trim()) ? '' : text(request.course, 200, 'Course');
    const courseId = request.courseId ?? null;
    if (courseId !== null) {
      if (typeof courseId !== 'string') throw new ApiError(400, BAD_BODY);
      // Legacy API clients may omit identity. Never infer it from a course label.
      const row = await this.first('SELECT title FROM professor_courses WHERE user_id = ? AND id = ? AND NOT archived', this.user, courseId);
      if (!row) throw new ApiError(400, 'Choose an available course from your Settings.');
      course = row.title;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const row = await this.first(`INSERT INTO lectures (join_code, title, lecture_time, owner_id, course, course_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (join_code) DO NOTHING RETURNING id`, code, title, time, this.user, course, courseId);
      if (row) return this.lectureById(row.id);
    }
    throw new ApiError(503, 'Could not allocate a lecture code. Please try again.');
  }

  async join(request) {
    const id = await this.lectureIdByCode(joinCode(request.code));
    const access = await this.access(id);
    if (!access.started_at || access.ended_at) throw new ApiError(404, 'This lecture has not started or has ended.');
    await this.db.batch([
      this.db.prepare(`INSERT INTO lecture_memberships (user_id, lecture_id, joined_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET lecture_id = excluded.lecture_id, joined_at = excluded.joined_at`).bind(this.user, id, now()),
      this.visitStatement(id),
    ]);
    return this.joinedSession();
  }

  async visit(id) {
    const lecture = await this.lectureById(id);
    await this.recordVisit(id);
    return lecture;
  }

  async submit(lecture, request) {
    const access = await this.access(lecture);
    if (access.ended_at) throw new ApiError(409, 'This lecture has ended.');
    if (!access.started_at) throw new ApiError(409, 'This lecture has not started yet.');
    if (access.questions_paused) throw new ApiError(409, 'Question submissions are paused for this lecture.');
    const question = text(request.text, 200, 'Question');
    if (blocks(question)) {
      await this.run('INSERT INTO question_moderation_warnings (lecture_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)',
        lecture, this.user, 'blacklisted_word', now());
      const { count } = await this.first('SELECT count(*) AS count FROM question_moderation_warnings WHERE lecture_id = ? AND user_id = ?', lecture, this.user);
      throw new ApiError(422, 'Question not sent. It contains wording that is not allowed. Edit it and try again.',
        { code: 'QUESTION_BLOCKED', warningCount: count });
    }
    const row = await this.first('INSERT INTO questions (lecture_id, author_id, text, submitted_at) VALUES (?, ?, ?, ?) RETURNING id',
      lecture, this.user, question, now());
    await this.recordVisit(lecture);
    return this.question(lecture, row.id);
  }

  async vote(id, request) {
    if (typeof request.voted !== 'boolean') throw new ApiError(400, 'Expected a voted boolean.');
    const question = await this.questionAccess(id);
    if (question.author_id === this.user) throw new ApiError(403, 'You are not allowed to upvote your own question');
    await this.db.batch([
      request.voted
        ? this.db.prepare('INSERT INTO question_votes (question_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(id, this.user)
        : this.db.prepare('DELETE FROM question_votes WHERE question_id = ? AND user_id = ?').bind(id, this.user),
      this.visitStatement(question.lecture_id),
    ]);
    return this.question(question.lecture_id, id);
  }

  async report(id) {
    const question = await this.questionAccess(id);
    await this.db.batch([
      this.db.prepare('INSERT INTO question_reports (question_id, user_id, reported_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(id, this.user, now()),
      this.visitStatement(question.lecture_id),
    ]);
  }

  async status(id, request) {
    if (!['open', 'selected', 'answered'].includes(request.status))
      throw new ApiError(400, 'Status must be open, selected, or answered.');
    const question = await this.questionAccess(id);
    await this.requireManage(question.lecture_id);
    const answered = request.status === 'answered';
    await this.run(`UPDATE questions SET status = ?, selected = ?,
      answered_at = CASE WHEN ? THEN COALESCE(answered_at, ?) ELSE NULL END WHERE id = ?`,
      answered ? 'answered' : 'unanswered', request.status === 'selected' ? 1 : 0, answered ? 1 : 0, now(), id);
    return (await this.professorQuestions(question.lecture_id)).find(q => q.id === String(id));
  }

  async deleteQuestion(id) {
    const question = await this.questionAccess(id);
    if (question.author_id !== this.user) await this.requireManage(question.lecture_id);
    await this.run('DELETE FROM questions WHERE id = ?', id);
  }

  async deleteLecture(id) {
    const access = await this.access(id);
    if (access.owner_id !== this.user) throw new ApiError(403, 'You do not manage this lecture.');
    if (!access.ended_at) throw new ApiError(409, 'Only completed sessions can be deleted.');
    // Questions cascade to votes and reports; history and memberships cascade from the lecture.
    await this.run('DELETE FROM lectures WHERE id = ?', id);
  }

  // LectureSession.java
  async session(id, request) {
    const access = await this.requireManage(id);
    const action = request.action;
    if (!['start', 'pause', 'resume', 'end'].includes(action))
      throw new ApiError(400, 'Action must be start, pause, resume, or end.');
    let next = { started: access.started_at, ended: access.ended_at, paused: Boolean(access.questions_paused) };
    if (!(action === 'end' && access.ended_at)) {
      if (access.ended_at) throw new ApiError(409, 'This lecture has ended.');
      if (action === 'start') {
        if (!access.started_at) next = { started: now(), ended: null, paused: false };
      } else {
        if (!access.started_at) throw new ApiError(409, 'Start the lecture first.');
        next = action === 'pause' ? { started: access.started_at, ended: null, paused: true }
          : action === 'resume' ? { started: access.started_at, ended: null, paused: false }
          : { started: access.started_at, ended: now(), paused: false };
      }
    }
    const statements = [this.db.prepare('UPDATE lectures SET started_at = ?, ended_at = ?, questions_paused = ? WHERE id = ?')
      .bind(next.started, next.ended, next.paused ? 1 : 0, id)];
    if (next.ended) statements.push(this.db.prepare('DELETE FROM lecture_memberships WHERE lecture_id = ?').bind(id));
    await this.db.batch(statements);
    return this.lectureById(id);
  }

  async summary() {
    const row = await this.first(`SELECT count(DISTINCT l.id) AS lectures,
        count(CASE WHEN q.status = 'unanswered' THEN 1 END) AS unanswered,
        count(CASE WHEN q.status = 'answered' THEN 1 END) AS answered
      FROM lectures l LEFT JOIN questions q ON q.lecture_id = l.id WHERE l.owner_id = ?`, this.user);
    return { lectureCount: row.lectures, unansweredCount: row.unanswered, answeredCount: row.answered };
  }

  async studentSummary() {
    const row = await this.first(`SELECT count(*) AS submitted, count(CASE WHEN status = 'answered' THEN 1 END) AS answered
      FROM questions WHERE author_id = ?`, this.user);
    return { submittedCount: row.submitted, answeredCount: row.answered };
  }

  async archive() {
    const ended = (await this.lectures()).filter(l => l.canManage && l.endedAt);
    return Promise.all(ended.map(async lecture => ({ lecture, questions: await this.professorQuestions(Number(lecture.id)) })));
  }

  async clearOpen(lecture, request) {
    await this.requireManage(lecture);
    const ids = request.questionIds;
    if (!Array.isArray(ids) || ids.length > 30000
        || ids.some(id => !(typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && /^\d{1,15}$/.test(id) && Number(id) > 0)))
      throw new ApiError(400, 'A valid snapshot of Open questions is required.');
    if (!ids.length) return { deletedIds: [] };
    // Only the confirmed snapshot is eligible, so later submissions always survive.
    const rows = await this.all(`DELETE FROM questions WHERE lecture_id = ? AND status = 'unanswered'
      AND id IN (SELECT value FROM json_each(?)) RETURNING id`, lecture, JSON.stringify([...new Set(ids.map(Number))]));
    return { deletedIds: rows.map(row => row.id).sort((a, b) => a - b).map(String) };
  }

  // ---- Professor profile (ProfessorProfileService.java) ----

  async profile() {
    const row = await this.first('SELECT onboarding_completed, revision FROM professor_profiles WHERE user_id = ?', this.user);
    if (!row) return null;
    const courses = await this.all('SELECT id, title FROM professor_courses WHERE user_id = ? AND NOT archived ORDER BY position', this.user);
    return { onboardingCompleted: Boolean(row.onboarding_completed), revision: row.revision,
      courses: courses.map(c => ({ id: c.id, title: c.title, historyKey: `${this.user}:${c.id}` })) };
  }

  static courses(update) {
    if (typeof update.onboardingCompleted !== 'boolean' || !Array.isArray(update.courses))
      throw new ApiError(400, 'Completion and courses are required.');
    const ids = new Set();
    const names = new Set();
    return update.courses.map(course => {
      if (!course || typeof course.id !== 'string' || !course.id.trim() || course.id.length > 200
          || typeof course.title !== 'string' || !course.title.trim() || course.title.trim().length > 120)
        throw new ApiError(400, 'Course titles must be 1 to 120 characters with a valid ID.');
      const title = course.title.trim();
      if (ids.has(course.id) || names.has(title.toLowerCase())) throw new ApiError(400, 'This course is already on your list.');
      ids.add(course.id);
      names.add(title.toLowerCase());
      return { id: course.id, title };
    });
  }

  async initializeProfile(legacy) {
    // Once present, ignore browser-local data.
    const existing = await this.profile();
    if (existing) return existing;
    const courses = Pool.courses(legacy);
    await this.db.batch([
      this.db.prepare('INSERT INTO professor_profiles (user_id, onboarding_completed) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .bind(this.user, legacy.onboardingCompleted ? 1 : 0),
      ...courses.map((course, i) => this.db.prepare('INSERT INTO professor_courses (user_id, id, title, position) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(this.user, course.id, course.title, i)),
    ]);
    return this.profile();
  }

  async saveProfile(update) {
    const courses = Pool.courses(update);
    const row = await this.first('SELECT revision FROM professor_profiles WHERE user_id = ?', this.user);
    if (!row) throw new ApiError(409, 'Load your professor profile before saving.');
    if (update.revision !== row.revision)
      throw new ApiError(409, 'Your courses changed in another browser. The latest list has been loaded; review it and retry.');
    const archived = new Set((await this.all('SELECT id FROM professor_courses WHERE user_id = ? AND archived', this.user)).map(c => c.id));
    if (courses.some(course => archived.has(course.id)))
      throw new ApiError(409, 'A removed course cannot reuse its old identity. Add it as a new course.');
    // The revision check runs inside the batch too, so a concurrent save cannot interleave.
    const results = await this.db.batch([
      this.db.prepare('UPDATE professor_profiles SET onboarding_completed = onboarding_completed OR ?, revision = revision + 1 WHERE user_id = ? AND revision = ?')
        .bind(update.onboardingCompleted ? 1 : 0, this.user, row.revision),
      // Temporarily archive the list so swaps of positions or names cannot hit
      // active-only uniqueness constraints. No course row is ever replaced.
      this.db.prepare('UPDATE professor_courses SET archived = 1 WHERE user_id = ?1 AND (SELECT revision FROM professor_profiles WHERE user_id = ?1) = ?2')
        .bind(this.user, row.revision + 1),
      ...courses.map((course, i) => this.db.prepare(`INSERT INTO professor_courses (user_id, id, title, position)
          SELECT ?1, ?2, ?3, ?4 WHERE (SELECT revision FROM professor_profiles WHERE user_id = ?1) = ?5
          ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, position = excluded.position, archived = 0`)
        .bind(this.user, course.id, course.title, i, row.revision + 1)),
    ]);
    if (!results[0].meta.changes)
      throw new ApiError(409, 'Your courses changed in another browser. The latest list has been loaded; review it and retry.');
    return this.profile();
  }
}

// ---- Routing (PoolController.java, ProfessorProfileController.java) ----

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, pattern: new RegExp(`^/api${pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/lectures', p => p.lectures());
route('POST', '/lectures', async (p, r) => created(await p.createLecture(await body(r)), l => `/api/lectures/${l.id}`));
route('GET', '/lectures/{lecture}', (p, r, a) => p.lectureById(longId(a.lecture)));
route('DELETE', '/lectures/{lecture}', (p, r, a) => p.deleteLecture(longId(a.lecture)));
route('POST', '/sessions/join', async (p, r) => p.join(await body(r)));
route('GET', '/student/lectures/history', p => p.history());
route('POST', '/lectures/{lecture}/visits', (p, r, a) => p.visit(longId(a.lecture)));
route('POST', '/lectures/by-code/{code}/visits', async (p, r, a) => p.visit(await p.lectureIdByCode(joinCode(decodeURIComponent(a.code)))));
route('DELETE', '/student/lectures/history/{lecture}', async (p, r, a) => {
  await p.run('DELETE FROM lecture_history WHERE user_id = ? AND lecture_id = ?', p.user, longId(a.lecture));
});
route('GET', '/sessions/mine', async p => ({ session: await p.joinedSession() }));
route('DELETE', '/sessions/mine', async p => { await p.run('DELETE FROM lecture_memberships WHERE user_id = ?', p.user); });
route('GET', '/lectures/{lecture}/questions', async (p, r, a) => {
  const lecture = longId(a.lecture);
  await p.access(lecture);
  return p.questions(lecture);
});
route('POST', '/lectures/{lecture}/questions', async (p, r, a) => {
  const lecture = longId(a.lecture);
  return created(await p.submit(lecture, await body(r)), q => `/api/lectures/${lecture}/questions/${q.id}`);
});
route('GET', '/lectures/{lecture}/questions/{id}', async (p, r, a) => {
  const lecture = longId(a.lecture);
  await p.access(lecture);
  return p.question(lecture, longId(a.id));
});
route('POST', '/questions/{id}/vote', async (p, r, a) => p.vote(longId(a.id), await body(r)));
route('POST', '/questions/{id}/report', (p, r, a) => p.report(longId(a.id)));
route('GET', '/lectures/{lecture}/professor/questions', async (p, r, a) => {
  const lecture = longId(a.lecture);
  await p.requireManage(lecture);
  return p.professorQuestions(lecture);
});
route('PATCH', '/questions/{id}/status', async (p, r, a) => p.status(longId(a.id), await body(r)));
route('DELETE', '/questions/{id}', (p, r, a) => p.deleteQuestion(longId(a.id)));
route('PATCH', '/lectures/{lecture}/session', async (p, r, a) => p.session(longId(a.lecture), await body(r)));
route('GET', '/professor/summary', p => p.summary());
route('GET', '/student/summary', p => p.studentSummary());
route('GET', '/professor/lectures/archive', p => p.archive());
route('POST', '/lectures/{lecture}/questions/clear-open', async (p, r, a) => p.clearOpen(longId(a.lecture), await body(r)));
route('GET', '/professor/profile', p => p.profile());
route('POST', '/professor/profile/initialize', async (p, r) => p.initializeProfile(await body(r)));
route('PUT', '/professor/profile', async (p, r) => p.saveProfile(await body(r)));

function created(value, location) {
  return json(201, value, { Location: location(value) });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/hello') return json(200, { message: 'Hello from Cloudflare Workers' });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.get('Origin') !== url.origin)
    return json(403, { error: 'A same-origin request is required.' });

  const user = await guest(request, env);
  const respond = response => {
    if (user.setCookie) response.headers.append('Set-Cookie', user.setCookie);
    return response;
  };
  if (url.pathname === '/api/me') {
    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT display_name FROM users WHERE identity = ?').bind(user.id).first();
      return respond(json(200, { id: user.id, name: row?.display_name || user.name }));
    }
    if (request.method === 'PUT') {
      // An empty name resets to the default guest name.
      let name;
      try {
        name = (await body(request)).name;
        if (typeof name !== 'string') throw new ApiError(400, 'Enter a name.');
        name = name.trim().replace(/\s+/g, ' ');
        if (name.length > 40) throw new ApiError(400, 'Your name must be at most 40 characters.');
        if (name && blocks(name)) throw new ApiError(422, 'That name contains wording that is not allowed.');
      } catch (error) {
        if (error instanceof ApiError) return respond(json(error.status, { error: error.message }));
        throw error;
      }
      await env.DB.prepare(`INSERT INTO users (identity, display_name) VALUES (?1, ?2)
        ON CONFLICT (identity) DO UPDATE SET display_name = excluded.display_name`).bind(user.id, name || null).run();
      return respond(json(200, { id: user.id, name: name || user.name }));
    }
  }

  let matched = false;
  for (const { method, pattern, handler } of routes) {
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    matched = true;
    if (method !== request.method) continue;
    try {
      await env.DB.prepare('INSERT INTO users (identity) VALUES (?) ON CONFLICT (identity) DO NOTHING').bind(user.id).run();
      const { id } = await env.DB.prepare('SELECT id FROM users WHERE identity = ?').bind(user.id).first();
      const value = await handler(new Pool(env.DB, id), request, match.groups || {});
      // Commands without a result are 204; GET /professor/profile may return JSON null.
      return respond(value instanceof Response ? value : value === undefined ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(200, value));
    } catch (error) {
      if (error instanceof ApiError) return respond(json(error.status, { error: error.message, ...error.extra }));
      if (/UNIQUE constraint|FOREIGN KEY constraint/.test(String(error?.message)))
        return respond(json(409, { error: 'This operation conflicts with existing data.' }));
      // Log metadata only: database errors can contain identities or question text.
      console.error('AskPool API failure', request.method, url.pathname, error?.name);
      return respond(json(500, { error: 'A server error prevented this operation. Please try again.' }));
    }
  }
  return respond(json(matched ? 405 : 404, { error: matched ? 'Method not allowed.' : 'Not found.' }));
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return api(request, env);
    return env.ASSETS.fetch(request);
  },
};
