import { Client } from "pg";

// Date-course planner API — no-login version, backed by Neon (via Hyperdrive).
//
// Every record here has courses.space_id IS NULL. Rows with a space_id belong to
// the login version (date-course-worker) and must never be read, changed or
// deleted from this API.
//
//   GET    /api/health                              (any method)
//   GET    /api/courses?from=YYYY-MM-DD&to=YYYY-MM-DD
//   POST   /api/courses
//   GET    /api/courses/{id}
//   PUT    /api/courses/{id}                        (full replace, same rules as POST)
//   DELETE /api/courses/{id}                        (hard delete)
//
// Everything outside /api/ is served from public/ via the ASSETS binding.

interface Env {
  HYPERDRIVE: { connectionString: string };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const bad = (msg: string) => new HttpError(400, msg);
const notFound = () => new HttpError(404, "해당 코스를 찾을 수 없어요.");
const unsupported = () => new HttpError(404, "지원하지 않는 요청입니다.");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------- validation ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD and a real calendar day (rejects 2026-02-30). */
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const str = (v: unknown) => String(v ?? "").trim();

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) throw bad("요청 본문이 비어 있습니다.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad("JSON 형식이 올바르지 않습니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("요청 형식이 올바르지 않습니다.");
  return body as Record<string, unknown>;
}

const MAX_MOOD = 30;
const MAX_TITLE = 100;
const MAX_MEMO = 2000;
const MAX_ITEM = 100;
const MAX_ITEMS = 30;

/** A single value or an array → trimmed, non-empty strings. Per-item length is checked before the count. */
function strList(value: unknown, label: string): string[] {
  if (value == null) return [];
  const out: string[] = [];
  for (const v of Array.isArray(value) ? value : [value]) {
    const s = str(v);
    if (!s) continue;
    if (s.length > MAX_ITEM) throw bad(`${label} 항목은 ${MAX_ITEM}자 이하로 입력해 주세요.`);
    out.push(s);
  }
  if (out.length > MAX_ITEMS) throw bad(`${label} 은(는) ${MAX_ITEMS}개까지 저장할 수 있어요.`);
  return out;
}

interface CourseInput {
  date: string;
  mood: string;
  title: string;
  places: string[];
  foods: string[];
  memo: string;
}

/** Shared by POST and PUT. Checks run in this order; the first failure wins. */
function cleanCourse(b: Record<string, unknown>): CourseInput {
  const date = str(b.date);
  if (!isValidDate(date)) throw bad("날짜를 올바르게 선택해 주세요.");
  const mood = str(b.mood);
  if (!mood) throw bad("오늘의 기분을 선택해 주세요.");
  if (mood.length > MAX_MOOD) throw bad("기분 값이 너무 깁니다.");
  const title = str(b.title);
  if (title.length > MAX_TITLE) throw bad(`제목은 ${MAX_TITLE}자 이하로 입력해 주세요.`);
  const memo = str(b.memo);
  if (memo.length > MAX_MEMO) throw bad(`메모는 ${MAX_MEMO}자 이하로 입력해 주세요.`);
  const places = strList(b.places, "장소");
  const foods = strList(b.foods, "먹거리");
  if (places.length === 0 && foods.length === 0) throw bad("장소나 먹거리를 하나 이상 골라 주세요.");
  return { date, mood, title, places, foods, memo };
}

// ---------- courses ----------

const COLUMNS = `id, date::text AS date, mood, title, places, foods, memo,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

const courseParams = (c: CourseInput) => [
  c.date, c.mood, c.title, JSON.stringify(c.places), JSON.stringify(c.foods), c.memo,
];

async function listCourses(db: Client, url: URL): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) throw bad("기간 형식이 올바르지 않습니다.");
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM courses
      WHERE space_id IS NULL
        AND ($1::date IS NULL OR date >= $1::date)
        AND ($2::date IS NULL OR date <= $2::date)
      ORDER BY date, created_at`,
    [from || null, to || null],
  );
  return json({ items: rows });
}

async function createCourse(db: Client, request: Request): Promise<Response> {
  const c = cleanCourse(await readBody(request));
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12); // 12 hex chars
  const { rows } = await db.query(
    `INSERT INTO courses (id, date, mood, title, places, foods, memo)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING ${COLUMNS}`,
    [id, ...courseParams(c)],
  );
  return json(rows[0], 201);
}

async function getCourse(db: Client, id: string): Promise<Response> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM courses WHERE id = $1 AND space_id IS NULL`, [id]);
  if (!rows[0]) throw notFound();
  return json(rows[0]);
}

async function updateCourse(db: Client, request: Request, id: string): Promise<Response> {
  const c = cleanCourse(await readBody(request));
  const { rows } = await db.query(
    `UPDATE courses SET date = $2, mood = $3, title = $4, places = $5::jsonb,
            foods = $6::jsonb, memo = $7, updated_at = now()
      WHERE id = $1 AND space_id IS NULL RETURNING ${COLUMNS}`,
    [id, ...courseParams(c)],
  );
  if (!rows[0]) throw notFound();
  return json(rows[0]);
}

async function deleteCourse(db: Client, id: string): Promise<Response> {
  const { rowCount } = await db.query(`DELETE FROM courses WHERE id = $1 AND space_id IS NULL`, [id]);
  if (!rowCount) throw notFound();
  return json({ ok: true });
}

// ---------- router ----------

const COURSE_PATH = /^\/api\/courses\/([A-Za-z0-9]+)$/;

async function route(request: Request, url: URL, db: Client): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") {
    await db.query("SELECT 1");
    return json({ ok: true });
  }
  if (path === "/api/courses") {
    if (method === "GET") return listCourses(db, url);
    if (method === "POST") return createCourse(db, request);
    throw unsupported();
  }
  const m = path.match(COURSE_PATH);
  if (m) {
    if (method === "GET") return getCourse(db, m[1]);
    if (method === "PUT") return updateCourse(db, request, m[1]);
    if (method === "DELETE") return deleteCourse(db, m[1]);
  }
  throw unsupported();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Connects before routing, so an unknown /api/ path also returns 500 while the DB is down.
    const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    try {
      await db.connect();
      return await route(request, url, db);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("API error", request.method, url.pathname, err);
      return json({ error: "서버에서 오류가 발생했어요." }, 500);
    } finally {
      await db.end().catch(() => {});
    }
  },
};
