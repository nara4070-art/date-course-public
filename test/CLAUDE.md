# test/ — 특성화 테스트

- `test/api.test.ts`는 `src/index.ts`의 **현재 동작을 고정하는 특성화(characterization) 테스트**다. HTTP 입출력과 DB 상태만 보고 SQL 문자열이나 내부 변수는 보지 않는다. 리팩토링하는 동안 이 테스트가 계속 통과해야 한다.
- `vi.mock("pg")` → `test/fake-pg.ts`: `Client`를 인메모리 Postgres(PGlite)로 바꾼다. 그래서 실제 SQL이 그대로 실행된다. 네트워크나 Neon은 필요 없다. `fake.failConnect`/`fake.failQuery`로 DB 장애를 흉내 낸다.
- `test/schema.sql`은 저장소 밖 `../date-course-worker/schema.sql`(저장소 루트 기준)의 **복사본**이다. 원본 스키마가 바뀌면 같이 복사할 것.
- 마지막 `describe("현재 동작 고정 (smells.md)")` 블록은 `docs/smells.md`의 이상한 동작(health가 메서드 무시, 405 대신 404, Origin 검사 없음 등)을 일부러 고정해 둔 것이다. 리팩토링에서 **의도적으로** 바꿀 때만 같은 변경에서 이 테스트를 고친다.
- 검증 케이스 표(`bodyErrors`, `fieldErrors`, `firstErrorWins`, `boundariesOk`)는 POST와 PUT에 똑같이 돌린다. 두 경로의 검증 규칙이 같다는 것을 보장한다.
