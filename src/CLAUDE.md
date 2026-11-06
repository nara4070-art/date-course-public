# src/ — 워커 코드

## 개요

"데이트 코스 플래너" — 날짜별 데이트 코스(기분, 제목, 장소, 먹거리, 메모)를 기록하는 웹앱. Cloudflare Workers + Neon Postgres(Hyperdrive 경유)로 동작한다. 이 저장소는 로그인 없는 버전이며, 저장소 상위 폴더에 로그인 버전과 보조 워커가 나란히 있다. (아래 경로는 저장소 루트 기준)

| 폴더 | Worker 이름 (`wrangler.jsonc`) | 역할 |
|---|---|---|
| `.` (이 저장소, `date-course-public`) | `date-course` | 로그인 없는 버전. 원래 URL에서 서비스. 모든 방문자가 하나의 기록을 공유 |
| `../date-course-worker/` | `date-course-login` | 로그인 버전. 커플 단위 "space"로 데이터 분리 |
| `../neon-hyperdrive-worker/` | `neon-hyperdrive-worker` | Hyperdrive 연결용 별도 워커 (`wrangler`가 devDependency로 설치된 유일한 프로젝트) |

세 워커 모두 **같은 Hyperdrive ID(`abe028abbe394df09ccd5c0b49b757ce`) = 같은 Neon DB**를 쓴다.

## 배포 · 스키마

빌드/린트 설정은 없다. 배포는 저장소 루트에서 `npx wrangler deploy` (= `npm run deploy`).

스키마 적용 및 예전 `courses.json` 가져오기 (`../date-course-worker/`에서):

```bash
DATABASE_URL=postgresql://... node scripts/migrate.mjs [path/to/courses.json]
```

`schema.sql`은 `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` 기반이라 반복 실행해도 안전하다. 스키마는 `../date-course-worker/schema.sql` 한 곳에만 있으며 두 버전이 공유한다.

## 공통 구조
- `src/index.ts`: `/api/*`만 워커가 처리하고 나머지는 `env.ASSETS.fetch`로 `public/` 정적 파일을 서빙 (`assets.run_worker_first: ["/api/*"]`).
- 요청마다 `pg` `Client`를 새로 열고 닫는다 (커넥션 풀링은 Hyperdrive가 담당). 로그인 버전은 `ctx.waitUntil(db.end())`, 이 버전은 응답 전에 `await db.end()`. `nodejs_compat` 필요.
- 코스 API 계약(`GET/POST /api/courses?from&to`, `GET/PUT/DELETE /api/courses/{id}`, `GET /api/health`)과 검증 규칙·에러 메시지(한국어)는 두 버전이 동일하다. 한쪽 검증 규칙을 바꾸면 다른 쪽도 맞춰야 한다.

## 두 버전의 데이터 분리
`courses.space_id`로 구분한다:
- `space_id IS NULL` → 로그인 없는 버전(`date-course-public`)의 기록. 모든 쿼리에 `space_id IS NULL` 조건이 붙는다.
- `space_id` 값 있음 → 로그인 버전의 해당 space 기록. 모든 쿼리가 `space_id = user.spaceId`로 스코프된다.

로그인 버전은 NULL 기록을 가져오지(adopt) 않는다. 이 경계를 깨는 쿼리를 만들지 말 것.

## 로그인 버전 인증 (`../date-course-worker/src/index.ts`)
- 테이블: `spaces`(커플 1쌍) / `users` / `sessions` / `invites` / `courses`.
- 첫 가입자가 space를 만들고, 두 번째 사람은 1회용 초대 링크(`/?invite=<token>`, 24시간 유효)로 가입해 합류. space당 최대 2명(`MAX_MEMBERS`).
- 비밀번호: PBKDF2-SHA256 100,000회(Workers 최대치), 사용자별 salt. 존재하지 않는 아이디에도 해시를 계산해 타이밍 차이를 숨긴다.
- 세션: `dc_sid` HttpOnly 쿠키(30일). DB에는 토큰의 sha256만 저장(초대 토큰도 동일).
- CSRF: GET/HEAD 외 요청은 `Origin`이 자기 origin이 아니면 403.
- 에러는 `HttpError(status, 한국어 메시지)`를 throw → 최상위에서 `{error}` JSON으로 변환.

## 로그인 없는 버전 (`src/index.ts`)
- 로그인 버전과 같은 구조: `HttpError` throw → `fetch`에서 `{error}` JSON으로 변환, `route()`가 핸들러(`listCourses`/`createCourse`/`getCourse`/`updateCourse`/`deleteCourse`)로 분기.
- POST와 PUT은 같은 `cleanCourse()`를 쓴다. 검증 순서(날짜 → 기분 → 제목 → 메모 → 장소 → 먹거리 → 최소 1개)가 곧 에러 우선순위다. 제한값은 파일 상단 `MAX_*` 상수.
- 일부러 남겨 둔 동작(테스트로 고정됨, `docs/smells.md` 참고): `/api/health`는 메서드 무시, 지원 안 하는 메서드는 404, 라우팅 전에 DB 연결(DB 장애 시 모든 `/api/*`가 500), 인증·Origin 검사 없음, 기간 없는 목록은 전체 반환. 바꾸려면 별도 변경으로 하고 해당 테스트를 같이 고칠 것.
- `npm run typecheck`(tsc, `src/`만)로 타입 검사. wrangler는 타입 검사를 하지 않는다.
