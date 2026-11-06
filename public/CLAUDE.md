# public/ — 프론트엔드

- `public/index.html`: 빌드 없는 단일 HTML(인라인 CSS/JS). 내부 `api(method, url, body)` 헬퍼로 API 호출. 로그인 버전(`../date-course-worker/public/index.html`, 저장소 루트 기준)은 cdnjs의 `qrcode-generator`로 초대 QR을 그린다.
- 워커가 `/api/*` 외의 요청을 이 폴더의 정적 파일로 서빙한다 (`src/CLAUDE.md` 참고).
