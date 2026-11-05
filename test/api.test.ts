// Characterization tests for src/index.ts (no-login version).
//
// These pin down what the API does *today* — status codes, response bodies,
// error messages, validation order and limits — so the file can be refactored
// safely. They only look at HTTP in/out and DB state, never at SQL text or
// internal variables, so restructuring the code should not require touching them.
//
// The "현재 동작 고정" block records quirks listed in docs/smells.md. If a
// refactor changes one of those on purpose, update that test in the same change.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fake, startDb, resetDb } from "./fake-pg";

vi.mock("pg", () => import("./fake-pg"));

const worker = (await import("../src/index.ts")).default;

const ORIGIN = "https://date-course.example";
const assetFetch = vi.fn(async (_req: Request) => new Response("<html>asset</html>", { status: 200 }));
const env = { HYPERDRIVE: { connectionString: "postgres://fake" }, ASSETS: { fetch: assetFetch } };

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, pending };
}

async function call(method: string, path: string, body?: unknown, rawBody?: string) {
  const init: RequestInit = { method, headers: {} };
  if (rawBody !== undefined) {
    init.body = rawBody;
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const ctx = makeCtx();
  const res: Response = await worker.fetch(new Request(ORIGIN + path, init), env, ctx);
  await Promise.all(ctx.pending);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

const valid = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-05",
  mood: "happy",
  title: "첫 데이트",
  places: ["한강공원"],
  foods: ["치킨"],
  memo: "좋았다",
  ...over,
});

async function create(over: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/courses", valid(over));
  expect(r.status).toBe(201);
  return r.json;
}

/** A row that belongs to the login version (space_id set). The public API must never see it. */
async function insertSpaceRow(id = "spacerow0001", date = "2026-11-05") {
  await fake.db!.query(`INSERT INTO spaces (id) VALUES ('sp1') ON CONFLICT DO NOTHING`);
  await fake.db!.query(
    `INSERT INTO courses (id, space_id, date, mood, title, places, foods, memo)
     VALUES ($1, 'sp1', $2, 'happy', '다른 커플', '["비밀장소"]', '[]', '')`,
    [id, date],
  );
  return id;
}

/** Insert a public row directly, with a controlled created_at (for ordering tests). */
async function insertPublicRow(id: string, date: string, createdAt: string, title = id) {
  await fake.db!.query(
    `INSERT INTO courses (id, date, mood, title, places, foods, memo, created_at, updated_at)
     VALUES ($1, $2, 'happy', $3, '["p"]', '[]', '', $4, $4)`,
    [id, date, title, createdAt],
  );
}

const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeAll(async () => {
  await startDb();
}, 60_000);

beforeEach(async () => {
  await resetDb();
  assetFetch.mockClear();
});

// ---------------------------------------------------------------------------
// Validation cases shared by POST and PUT. Order matters: the first failing
// check wins, so each case breaks exactly one rule on top of a valid body.
// ---------------------------------------------------------------------------
const long = (n: number) => "가".repeat(n);
const many = (n: number) => Array.from({ length: n }, (_, i) => `항목${i}`);

const bodyErrors: [string, string | undefined, string][] = [
  ["빈 본문", "", "요청 본문이 비어 있습니다."],
  ["공백만 있는 본문", "   \n ", "요청 본문이 비어 있습니다."],
  ["깨진 JSON", "{date:", "JSON 형식이 올바르지 않습니다."],
  ["JSON 배열", "[]", "요청 형식이 올바르지 않습니다."],
  ["JSON null", "null", "요청 형식이 올바르지 않습니다."],
  ["JSON 숫자", "123", "요청 형식이 올바르지 않습니다."],
];

const fieldErrors: [string, Record<string, unknown>, string][] = [
  ["날짜 없음", { date: undefined }, "날짜를 올바르게 선택해 주세요."],
  ["날짜 YYYYMMDD", { date: "20261105" }, "날짜를 올바르게 선택해 주세요."],
  ["없는 날짜 2/30", { date: "2026-02-30" }, "날짜를 올바르게 선택해 주세요."],
  ["날짜에 시간 포함", { date: "2026-11-05T10:00" }, "날짜를 올바르게 선택해 주세요."],
  ["기분 없음", { mood: undefined }, "오늘의 기분을 선택해 주세요."],
  ["기분 공백", { mood: "   " }, "오늘의 기분을 선택해 주세요."],
  ["기분 31자", { mood: long(31) }, "기분 값이 너무 깁니다."],
  ["제목 101자", { title: long(101) }, "제목은 100자 이하로 입력해 주세요."],
  ["메모 2001자", { memo: long(2001) }, "메모는 2000자 이하로 입력해 주세요."],
  ["장소 항목 101자", { places: [long(101)] }, "장소 항목은 100자 이하로 입력해 주세요."],
  ["장소 31개", { places: many(31) }, "장소 은(는) 30개까지 저장할 수 있어요."],
  ["먹거리 항목 101자", { foods: [long(101)] }, "먹거리 항목은 100자 이하로 입력해 주세요."],
  ["먹거리 31개", { foods: many(31) }, "먹거리 은(는) 30개까지 저장할 수 있어요."],
  ["장소·먹거리 모두 없음", { places: [], foods: [] }, "장소나 먹거리를 하나 이상 골라 주세요."],
  ["장소·먹거리 빈 문자열뿐", { places: ["", "  "], foods: [null] }, "장소나 먹거리를 하나 이상 골라 주세요."],
  ["장소·먹거리 필드 자체가 없음", { places: undefined, foods: undefined }, "장소나 먹거리를 하나 이상 골라 주세요."],
];

const firstErrorWins: [string, Record<string, unknown>, string][] = [
  ["날짜 → 기분 순", { date: "bad", mood: "" }, "날짜를 올바르게 선택해 주세요."],
  ["기분 → 제목 순", { mood: "", title: long(101) }, "오늘의 기분을 선택해 주세요."],
  ["제목 → 메모 순", { title: long(101), memo: long(2001) }, "제목은 100자 이하로 입력해 주세요."],
  ["메모 → 장소 순", { memo: long(2001), places: [long(101)] }, "메모는 2000자 이하로 입력해 주세요."],
  ["장소 → 먹거리 순", { places: many(31), foods: many(31) }, "장소 은(는) 30개까지 저장할 수 있어요."],
];

const boundariesOk: [string, Record<string, unknown>][] = [
  ["기분 30자", { mood: long(30) }],
  ["제목 100자", { title: long(100) }],
  ["메모 2000자", { memo: long(2000) }],
  ["장소 항목 100자", { places: [long(100)] }],
  ["장소 30개", { places: many(30) }],
  ["먹거리 30개 (장소 없음)", { places: [], foods: many(30) }],
  ["윤년 2/29", { date: "2028-02-29" }],
];

// ---------------------------------------------------------------------------

describe("정적 파일", () => {
  it.each(["/", "/index.html", "/api", "/apix/courses"])("%s 는 ASSETS로 넘기고 DB에 연결하지 않는다", async (p) => {
    const r = await call("GET", p);
    expect(r.status).toBe(200);
    expect(r.text).toBe("<html>asset</html>");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(fake.connects).toBe(0);
  });
});

describe("공통 응답 형식", () => {
  it("JSON + no-store 헤더", async () => {
    const r = await call("GET", "/api/health");
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("에러도 {error} JSON + no-store", async () => {
    const r = await call("GET", "/api/courses/nope00000000");
    expect(r.json).toEqual({ error: "해당 코스를 찾을 수 없어요." });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("요청마다 DB 연결을 닫는다", async () => {
    await call("GET", "/api/health");
    await call("GET", "/api/courses");
    expect(fake.ends).toBe(fake.connects);
  });
});

describe("GET /api/health", () => {
  it("200 {ok:true}", async () => {
    const r = await call("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });
});

describe("POST /api/courses", () => {
  it("201, 저장된 코스를 그대로 돌려준다", async () => {
    const r = await call("POST", "/api/courses", valid());
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      date: "2026-11-05",
      mood: "happy",
      title: "첫 데이트",
      places: ["한강공원"],
      foods: ["치킨"],
      memo: "좋았다",
      createdAt: expect.stringMatching(ISO_MS_Z),
      updatedAt: expect.stringMatching(ISO_MS_Z),
    });
    expect(r.json.updatedAt).toBe(r.json.createdAt);
    expect(Object.keys(r.json)).toEqual(
      ["id", "date", "mood", "title", "places", "foods", "memo", "createdAt", "updatedAt"],
    );
  });

  it("저장 후 목록·상세에서 같은 값이 보인다", async () => {
    const c = await create();
    expect((await call("GET", `/api/courses/${c.id}`)).json).toEqual(c);
    expect((await call("GET", "/api/courses")).json).toEqual({ items: [c] });
  });

  it("id는 매번 다르다", async () => {
    const a = await create();
    const b = await create();
    expect(a.id).not.toBe(b.id);
  });

  it("문자열 값은 앞뒤 공백을 자른다", async () => {
    const c = await create({ date: " 2026-11-05 ", mood: " happy ", title: "  제목  ", memo: "\n메모\n", places: ["  장소  "], foods: [" 음식 "] });
    expect(c).toMatchObject({ date: "2026-11-05", mood: "happy", title: "제목", memo: "메모", places: ["장소"], foods: ["음식"] });
  });

  it("제목·메모가 없거나 null이면 빈 문자열", async () => {
    const c = await create({ title: undefined, memo: null });
    expect(c.title).toBe("");
    expect(c.memo).toBe("");
  });

  it("장소·먹거리: 단일 값은 배열로, 빈 값은 빼고, 숫자는 문자열로", async () => {
    const c = await create({ places: "한강", foods: ["", null, "  ", 123, "떡볶이"] });
    expect(c.places).toEqual(["한강"]);
    expect(c.foods).toEqual(["123", "떡볶이"]);
  });

  it("장소만 / 먹거리만 있어도 된다", async () => {
    expect((await create({ foods: [] })).foods).toEqual([]);
    expect((await create({ places: null })).places).toEqual([]);
  });

  it("날짜가 아닌 다른 타입도 문자열로 바꿔 검사한다 (숫자 mood 허용)", async () => {
    expect((await create({ mood: 5 })).mood).toBe("5");
  });

  it("알 수 없는 필드는 무시한다", async () => {
    const c = await create({ id: "hacked000000", space_id: "sp1", createdAt: "2000-01-01" });
    expect(c.id).not.toBe("hacked000000");
    expect(c.createdAt).not.toMatch(/^2000/);
    const { rows } = await fake.db!.query(`SELECT space_id FROM courses WHERE id = $1`, [c.id]);
    expect(rows).toEqual([{ space_id: null }]);
  });

  it.each(bodyErrors)("400 %s", async (_n, raw, msg) => {
    const r = await call("POST", "/api/courses", undefined, raw);
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: msg });
  });

  it.each(fieldErrors)("400 %s", async (_n, over, msg) => {
    const r = await call("POST", "/api/courses", valid(over));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: msg });
  });

  it.each(firstErrorWins)("여러 개가 틀리면 첫 번째만: %s", async (_n, over, msg) => {
    const r = await call("POST", "/api/courses", valid(over));
    expect(r.json).toEqual({ error: msg });
  });

  it.each(boundariesOk)("경계값 통과: %s", async (_n, over) => {
    const r = await call("POST", "/api/courses", valid(over));
    expect(r.status).toBe(201);
  });

  it("검증 실패 시 아무것도 저장하지 않는다", async () => {
    await call("POST", "/api/courses", valid({ mood: "" }));
    const { rows } = await fake.db!.query(`SELECT count(*)::int AS n FROM courses`);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("GET /api/courses (목록)", () => {
  beforeEach(async () => {
    await insertPublicRow("c3", "2026-11-10", "2026-01-01T00:00:00Z");
    await insertPublicRow("c1b", "2026-11-01", "2026-01-02T00:00:00Z");
    await insertPublicRow("c1a", "2026-11-01", "2026-01-01T00:00:00Z");
    await insertPublicRow("c2", "2026-11-05", "2026-01-01T00:00:00Z");
    await insertSpaceRow("spacerow0001", "2026-11-05");
  });

  const ids = (r: { json: any }) => r.json.items.map((c: any) => c.id);

  it("날짜 → 생성시각 순으로 정렬, 로그인 버전 기록은 빠진다", async () => {
    const r = await call("GET", "/api/courses");
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(["c1a", "c1b", "c2", "c3"]);
  });

  it("from/to 는 양 끝을 포함한다", async () => {
    expect(ids(await call("GET", "/api/courses?from=2026-11-05&to=2026-11-10"))).toEqual(["c2", "c3"]);
    expect(ids(await call("GET", "/api/courses?from=2026-11-05"))).toEqual(["c2", "c3"]);
    expect(ids(await call("GET", "/api/courses?to=2026-11-01"))).toEqual(["c1a", "c1b"]);
    expect(ids(await call("GET", "/api/courses?from=2026-11-02&to=2026-11-04"))).toEqual([]);
  });

  it("from > to 이면 빈 목록 (에러 아님)", async () => {
    const r = await call("GET", "/api/courses?from=2026-12-01&to=2026-11-01");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [] });
  });

  it("빈 from/to 는 조건 없음으로 본다", async () => {
    expect(ids(await call("GET", "/api/courses?from=&to="))).toHaveLength(4);
  });

  it.each([
    ["from", "/api/courses?from=20261101"],
    ["from", "/api/courses?from=2026-02-30"],
    ["to", "/api/courses?to=nope"],
    ["둘 다", "/api/courses?from=x&to=y"],
  ])("400 잘못된 %s", async (_n, p) => {
    const r = await call("GET", p);
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "기간 형식이 올바르지 않습니다." });
  });

  it("각 항목의 모양", async () => {
    const r = await call("GET", "/api/courses?from=2026-11-05&to=2026-11-05");
    expect(r.json.items[0]).toEqual({
      id: "c2",
      date: "2026-11-05",
      mood: "happy",
      title: "c2",
      places: ["p"],
      foods: [],
      memo: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("GET /api/courses/{id}", () => {
  it("404 없는 id", async () => {
    const r = await call("GET", "/api/courses/abc123");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "해당 코스를 찾을 수 없어요." });
  });

  it("404 로그인 버전 기록은 id를 알아도 못 본다", async () => {
    const id = await insertSpaceRow();
    expect((await call("GET", `/api/courses/${id}`)).status).toBe(404);
  });
});

describe("PUT /api/courses/{id}", () => {
  it("200, 바뀐 값을 돌려주고 createdAt은 유지, updatedAt은 갱신", async () => {
    await insertPublicRow("old000000001", "2026-01-01", "2026-01-01T00:00:00Z");
    const r = await call("PUT", "/api/courses/old000000001", valid({ title: "바뀐 제목", places: ["새 장소"] }));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "old000000001", date: "2026-11-05", title: "바뀐 제목", places: ["새 장소"], foods: ["치킨"] });
    expect(r.json.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(r.json.updatedAt).toMatch(ISO_MS_Z);
    expect(r.json.updatedAt > r.json.createdAt).toBe(true);
    expect((await call("GET", "/api/courses/old000000001")).json).toEqual(r.json);
  });

  it("부분 수정이 아니라 전체 교체다 (빠진 필드는 빈 값)", async () => {
    const c = await create({ title: "원래 제목", memo: "원래 메모" });
    const r = await call("PUT", `/api/courses/${c.id}`, { date: c.date, mood: c.mood, places: ["x"] });
    expect(r.json).toMatchObject({ title: "", memo: "", foods: [], places: ["x"] });
  });

  it("404 없는 id (검증은 통과한 경우)", async () => {
    const r = await call("PUT", "/api/courses/nope00000000", valid());
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "해당 코스를 찾을 수 없어요." });
  });

  it("없는 id라도 본문이 틀리면 400이 먼저", async () => {
    const r = await call("PUT", "/api/courses/nope00000000", valid({ mood: "" }));
    expect(r.status).toBe(400);
  });

  it("404 로그인 버전 기록은 고칠 수 없고 원본도 그대로", async () => {
    const id = await insertSpaceRow();
    expect((await call("PUT", `/api/courses/${id}`, valid())).status).toBe(404);
    const { rows } = await fake.db!.query(`SELECT title FROM courses WHERE id = $1`, [id]);
    expect(rows).toEqual([{ title: "다른 커플" }]);
  });

  // POST와 PUT은 같은 검증 규칙이어야 한다 (지금은 코드가 복붙이라 따로 확인).
  it.each(bodyErrors)("400 %s", async (_n, raw, msg) => {
    const c = await create();
    const r = await call("PUT", `/api/courses/${c.id}`, undefined, raw);
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: msg });
  });

  it.each(fieldErrors)("400 %s", async (_n, over, msg) => {
    const c = await create();
    const r = await call("PUT", `/api/courses/${c.id}`, valid(over));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: msg });
  });

  it.each(firstErrorWins)("여러 개가 틀리면 첫 번째만: %s", async (_n, over, msg) => {
    const c = await create();
    expect((await call("PUT", `/api/courses/${c.id}`, valid(over))).json).toEqual({ error: msg });
  });

  it.each(boundariesOk)("경계값 통과: %s", async (_n, over) => {
    const c = await create();
    expect((await call("PUT", `/api/courses/${c.id}`, valid(over))).status).toBe(200);
  });

  it("검증 실패 시 원본은 그대로", async () => {
    const c = await create();
    await call("PUT", `/api/courses/${c.id}`, valid({ title: long(101) }));
    expect((await call("GET", `/api/courses/${c.id}`)).json).toEqual(c);
  });
});

describe("DELETE /api/courses/{id}", () => {
  it("200 {ok:true}, 이후 조회는 404", async () => {
    const c = await create();
    const r = await call("DELETE", `/api/courses/${c.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect((await call("GET", `/api/courses/${c.id}`)).status).toBe(404);
  });

  it("행이 DB에서 실제로 사라진다 (물리 삭제 — 주석의 '논리삭제'와 다름)", async () => {
    const c = await create();
    await call("DELETE", `/api/courses/${c.id}`);
    const { rows } = await fake.db!.query(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [c.id]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it("404 없는 id / 두 번째 삭제", async () => {
    const c = await create();
    await call("DELETE", `/api/courses/${c.id}`);
    const r = await call("DELETE", `/api/courses/${c.id}`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "해당 코스를 찾을 수 없어요." });
  });

  it("404 로그인 버전 기록은 지울 수 없다", async () => {
    const id = await insertSpaceRow();
    expect((await call("DELETE", `/api/courses/${id}`)).status).toBe(404);
    const { rows } = await fake.db!.query(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ n: 1 });
  });
});

describe("라우팅: 지원하지 않는 요청", () => {
  it.each([
    ["GET", "/api/unknown"],
    ["GET", "/api/"],
    ["GET", "/api/courses/"],
    ["GET", "/api/courses/a/b"],
    ["GET", "/api/courses/has-dash"],
    ["GET", "/api/courses/has_underscore"],
    ["POST", "/api/courses/abc123"],
    ["PATCH", "/api/courses"],
    ["DELETE", "/api/courses"],
    ["PUT", "/api/courses"],
    ["PATCH", "/api/courses/abc123"],
  ])("%s %s → 404 지원하지 않는 요청입니다.", async (m, p) => {
    const r = await call(m, p);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "지원하지 않는 요청입니다." });
  });

  it("쿼리스트링은 라우팅에 영향 없음", async () => {
    expect((await call("GET", "/api/health?x=1")).json).toEqual({ ok: true });
  });
});

describe("DB 오류", () => {
  it("쿼리 실패 → 500, 내부 오류 내용은 숨긴다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failQuery = true;
    const r = await call("GET", "/api/courses");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "서버에서 오류가 발생했어요." });
    expect(r.text).not.toContain("fake:");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("연결 실패 → 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failConnect = true;
    const r = await call("GET", "/api/health");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "서버에서 오류가 발생했어요." });
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 현재 동작 고정 — docs/smells.md 에 적힌 이상한 동작들.
// 리팩토링 중 "의도적으로" 바꾸려면 이 테스트를 같은 변경에서 고칠 것.
// 의도 없이 깨졌다면 리팩토링이 동작을 바꾼 것이다.
// ---------------------------------------------------------------------------
describe("현재 동작 고정 (smells.md)", () => {
  it("/api/health 는 메서드를 가리지 않는다 (POST도 200)", async () => {
    expect((await call("POST", "/api/health")).json).toEqual({ ok: true });
    expect((await call("DELETE", "/api/health")).status).toBe(200);
  });

  it("지원하지 않는 메서드는 405가 아니라 404", async () => {
    expect((await call("PATCH", "/api/courses")).status).toBe(404);
  });

  it("DB가 죽어 있으면 없는 경로도 404가 아니라 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failConnect = true;
    expect((await call("GET", "/api/unknown")).status).toBe(500);
    spy.mockRestore();
  });

  it("기간 없이 목록을 부르면 '최근 30일'이 아니라 전체가 나온다", async () => {
    await insertPublicRow("ancient00001", "2000-01-01", "2000-01-01T00:00:00Z");
    await insertPublicRow("future000001", "2099-12-31", "2000-01-01T00:00:00Z");
    expect((await call("GET", "/api/courses")).json.items.map((c: any) => c.id)).toEqual(["ancient00001", "future000001"]);
  });

  it("인증·Origin 검사 없음: 다른 사이트 Origin의 DELETE도 성공", async () => {
    const c = await create();
    const ctx = makeCtx();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/courses/${c.id}`, { method: "DELETE", headers: { Origin: "https://evil.example" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("id 형식 검사는 영숫자만 — 길이 제한 없음 (긴 id도 404로 정상 처리)", async () => {
    const r = await call("GET", "/api/courses/" + "a".repeat(500));
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "해당 코스를 찾을 수 없어요." });
  });

  it("에러 메시지의 어색한 조사 '장소 은(는)' 그대로", async () => {
    expect((await call("POST", "/api/courses", valid({ places: many(31) }))).json.error).toBe("장소 은(는) 30개까지 저장할 수 있어요.");
  });
});
