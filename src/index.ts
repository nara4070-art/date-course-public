// @ts-nocheck
/*
 * =====================================================================
 *   데이트코스 API 서버  v2.3.1 (최종_진짜최종_수정본)
 *
 *   최초작성 : 2019.03.12  (김대리)
 *   수정이력 : 2021.11.02  (박과장) - 오라클 -> MySQL 전환
 *              2023.02.17  (외주)   - 서버 이전
 *              2023.02.18  (외주)   - 긴급패치
 *
 *   ※ 이 파일 함부로 수정하지 말것!!! 운영 장애남
 *   ※ DB는 MySQL 5.7 기준임 (아마도)
 * =====================================================================
 */
import { Client } from "pg";

// 전역 설정 (나중에 config.properties로 뺄 예정)
var VERSION = "2.3.1";
var DEBUG = false; // true 로 바꾸면 로그 출력됨
// var MAX_ITEMS = 50;
// var USE_CACHE = true;
// var DB_HOST = "192.168.0.15";

export default {
  // 메인
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;
    var resStatus = 200;
    var resBody = null;
    var flag = 0; // 0:정상, 1:에러, 2:경고(사용안함)
    var errMsg = "";
    var db = null;
    var i, j, s, arr, arr2, txt, body, rs, id, d, ok, tmp, tmp2;
    var date, mood, title, memo, places, foods, from, to;

    // 정적파일 처리 (apache 에서 넘어오는거)
    if (path.indexOf("/api/") != 0) {
      return env.ASSETS.fetch(request);
    }

    db = new Client({ connectionString: env.HYPERDRIVE.connectionString });

    try {
      await db.connect(); // 커넥션풀 사용

      // 헬스체크 (L4 장비 체크용, 지우면 안됨)
      if (path == "/api/health") {
        rs = await db.query("SELECT 1");
        resBody = { ok: true };
      }
      // ---------------------------------------------------------
      //  목록조회
      // ---------------------------------------------------------
      else if (path == "/api/courses" && method == "GET") {
        from = url.searchParams.get("from");
        to = url.searchParams.get("to");

        // 날짜는 YYYYMMDD 형식
        if (from) {
          ok = false;
          if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
            d = new Date(from + "T00:00:00Z");
            if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) == from) {
              ok = true;
            }
          }
          if (ok == false) {
            flag = 1;
            resStatus = 400;
            errMsg = "기간 형식이 올바르지 않습니다.";
          }
        }
        if (to && flag == 0) {
          ok = false;
          if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            d = new Date(to + "T00:00:00Z");
            if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) == to) {
              ok = true;
            }
          }
          if (ok == false) {
            flag = 1;
            resStatus = 400;
            errMsg = "기간 형식이 올바르지 않습니다.";
          }
        }

        if (flag == 0) {
          // 최근 30일치만 조회
          rs = await db.query(
            "SELECT id, date::text AS date, mood, title, places, foods, memo, " +
              "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", " +
              "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"updatedAt\" " +
              "FROM courses " +
              "WHERE space_id IS NULL " +
              "AND ($1::date IS NULL OR date >= $1::date) " +
              "AND ($2::date IS NULL OR date <= $2::date) " +
              "ORDER BY date, created_at",
            [from || null, to || null]
          );
          resBody = { items: rs.rows };
        }
      }
      // ---------------------------------------------------------
      //  등록
      // ---------------------------------------------------------
      else if (path == "/api/courses" && method == "POST") {
        txt = await request.text();
        if (txt.trim() == "") {
          flag = 1;
          resStatus = 400;
          errMsg = "요청 본문이 비어 있습니다.";
        }
        if (flag == 0) {
          try {
            body = JSON.parse(txt);
          } catch (e) {
            flag = 1;
            resStatus = 400;
            errMsg = "JSON 형식이 올바르지 않습니다.";
          }
        }
        if (flag == 0) {
          if (!body || typeof body != "object" || Array.isArray(body)) {
            flag = 1;
            resStatus = 400;
            errMsg = "요청 형식이 올바르지 않습니다.";
          }
        }

        // 입력값 체크
        if (flag == 0) {
          date = String(body.date == null ? "" : body.date).trim();
          ok = false;
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            d = new Date(date + "T00:00:00Z");
            if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) == date) {
              ok = true;
            }
          }
          if (ok == false) {
            flag = 1;
            resStatus = 400;
            errMsg = "날짜를 올바르게 선택해 주세요.";
          }
        }
        if (flag == 0) {
          mood = String(body.mood == null ? "" : body.mood).trim();
          if (mood == "") {
            flag = 1;
            resStatus = 400;
            errMsg = "오늘의 기분을 선택해 주세요.";
          } else if (mood.length > 30) {
            flag = 1;
            resStatus = 400;
            errMsg = "기분 값이 너무 깁니다.";
          }
        }
        if (flag == 0) {
          title = String(body.title == null ? "" : body.title).trim(); // XSS 방지
          if (title.length > 100) {
            flag = 1;
            resStatus = 400;
            errMsg = "제목은 100자 이하로 입력해 주세요.";
          }
        }
        if (flag == 0) {
          memo = String(body.memo == null ? "" : body.memo).trim();
          // 메모는 최대 500자
          if (memo.length > 2000) {
            flag = 1;
            resStatus = 400;
            errMsg = "메모는 2000자 이하로 입력해 주세요.";
          }
        }
        // 장소
        if (flag == 0) {
          places = [];
          if (body.places != null) {
            arr = Array.isArray(body.places) ? body.places : [body.places];
            for (i = 0; i < arr.length; i++) {
              s = String(arr[i] == null ? "" : arr[i]).trim();
              if (s == "") continue;
              if (s.length > 100) {
                flag = 1;
                resStatus = 400;
                errMsg = "장소 항목은 100자 이하로 입력해 주세요.";
                break;
              }
              places.push(s);
            }
            // 최대 50개
            if (flag == 0 && places.length > 30) {
              flag = 1;
              resStatus = 400;
              errMsg = "장소 은(는) 30개까지 저장할 수 있어요.";
            }
          }
        }
        // 먹거리 (장소랑 똑같음)
        if (flag == 0) {
          foods = [];
          if (body.foods != null) {
            arr = Array.isArray(body.foods) ? body.foods : [body.foods];
            for (i = 0; i < arr.length; i++) {
              s = String(arr[i] == null ? "" : arr[i]).trim();
              if (s == "") continue;
              if (s.length > 100) {
                flag = 1;
                resStatus = 400;
                errMsg = "먹거리 항목은 100자 이하로 입력해 주세요.";
                break;
              }
              foods.push(s);
            }
            if (flag == 0 && foods.length > 30) {
              flag = 1;
              resStatus = 400;
              errMsg = "먹거리 은(는) 30개까지 저장할 수 있어요.";
            }
          }
        }
        if (flag == 0) {
          if (places.length == 0 && foods.length == 0) {
            flag = 1;
            resStatus = 400;
            errMsg = "장소나 먹거리를 하나 이상 골라 주세요.";
          }
        }

        if (flag == 0) {
          // id는 UUID 36자리
          id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          // 트랜잭션 처리
          rs = await db.query(
            "INSERT INTO courses (id, date, mood, title, places, foods, memo) " +
              "VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) " +
              "RETURNING id, date::text AS date, mood, title, places, foods, memo, " +
              "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", " +
              "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"updatedAt\"",
            [id, date, mood, title, JSON.stringify(places), JSON.stringify(foods), memo]
          );
          // if (rs.rowCount == 0) { flag = 1; }  // 2021.11 주석처리 (박과장)
          resBody = rs.rows[0];
          resStatus = 201;
        }
      }
      // ---------------------------------------------------------
      //  상세 / 수정 / 삭제
      // ---------------------------------------------------------
      else if (
        (arr2 = path.split("/")).length == 4 &&
        arr2[1] == "api" &&
        arr2[2] == "courses" &&
        /^[A-Za-z0-9]+$/.test(arr2[3]) &&
        (method == "GET" || method == "PUT" || method == "DELETE")
      ) {
        id = arr2[3];

        if (method == "GET") {
          rs = await db.query(
            "SELECT id, date::text AS date, mood, title, places, foods, memo, " +
              "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", " +
              "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"updatedAt\" " +
              "FROM courses WHERE id = $1 AND space_id IS NULL",
            [id]
          );
          if (rs.rows.length > 0) {
            resBody = rs.rows[0];
          } else {
            flag = 1;
            resStatus = 404;
            errMsg = "해당 코스를 찾을 수 없어요.";
          }
        }
        else if (method == "PUT") {
          // 등록이랑 같음. 수정시 같이 고칠것!!
          txt = await request.text();
          if (txt.trim() == "") {
            flag = 1;
            resStatus = 400;
            errMsg = "요청 본문이 비어 있습니다.";
          }
          if (flag == 0) {
            try {
              body = JSON.parse(txt);
            } catch (e) {
              flag = 1;
              resStatus = 400;
              errMsg = "JSON 형식이 올바르지 않습니다.";
            }
          }
          if (flag == 0) {
            if (!body || typeof body != "object" || Array.isArray(body)) {
              flag = 1;
              resStatus = 400;
              errMsg = "요청 형식이 올바르지 않습니다.";
            }
          }
          if (flag == 0) {
            date = String(body.date == null ? "" : body.date).trim();
            ok = false;
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              d = new Date(date + "T00:00:00Z");
              if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) == date) {
                ok = true;
              }
            }
            if (ok == false) {
              flag = 1;
              resStatus = 400;
              errMsg = "날짜를 올바르게 선택해 주세요.";
            }
          }
          if (flag == 0) {
            mood = String(body.mood == null ? "" : body.mood).trim();
            if (mood == "") {
              flag = 1;
              resStatus = 400;
              errMsg = "오늘의 기분을 선택해 주세요.";
            } else if (mood.length > 30) {
              flag = 1;
              resStatus = 400;
              errMsg = "기분 값이 너무 깁니다.";
            }
          }
          if (flag == 0) {
            title = String(body.title == null ? "" : body.title).trim();
            if (title.length > 100) {
              flag = 1;
              resStatus = 400;
              errMsg = "제목은 100자 이하로 입력해 주세요.";
            }
          }
          if (flag == 0) {
            memo = String(body.memo == null ? "" : body.memo).trim();
            if (memo.length > 2000) {
              flag = 1;
              resStatus = 400;
              errMsg = "메모는 2000자 이하로 입력해 주세요.";
            }
          }
          if (flag == 0) {
            places = [];
            if (body.places != null) {
              arr = Array.isArray(body.places) ? body.places : [body.places];
              for (j = 0; j < arr.length; j++) {
                tmp = String(arr[j] == null ? "" : arr[j]).trim();
                if (tmp == "") continue;
                if (tmp.length > 100) {
                  flag = 1;
                  resStatus = 400;
                  errMsg = "장소 항목은 100자 이하로 입력해 주세요.";
                  break;
                }
                places.push(tmp);
              }
              if (flag == 0 && places.length > 30) {
                flag = 1;
                resStatus = 400;
                errMsg = "장소 은(는) 30개까지 저장할 수 있어요.";
              }
            }
          }
          if (flag == 0) {
            foods = [];
            if (body.foods != null) {
              arr = Array.isArray(body.foods) ? body.foods : [body.foods];
              for (j = 0; j < arr.length; j++) {
                tmp2 = String(arr[j] == null ? "" : arr[j]).trim();
                if (tmp2 == "") continue;
                if (tmp2.length > 100) {
                  flag = 1;
                  resStatus = 400;
                  errMsg = "먹거리 항목은 100자 이하로 입력해 주세요.";
                  break;
                }
                foods.push(tmp2);
              }
              if (flag == 0 && foods.length > 30) {
                flag = 1;
                resStatus = 400;
                errMsg = "먹거리 은(는) 30개까지 저장할 수 있어요.";
              }
            }
          }
          if (flag == 0) {
            if (places.length == 0 && foods.length == 0) {
              flag = 1;
              resStatus = 400;
              errMsg = "장소나 먹거리를 하나 이상 골라 주세요.";
            }
          }
          if (flag == 0) {
            // 수정자 ID도 같이 저장
            rs = await db.query(
              "UPDATE courses SET date = $2, mood = $3, title = $4, places = $5::jsonb, " +
                "foods = $6::jsonb, memo = $7, updated_at = now() " +
                "WHERE id = $1 AND space_id IS NULL " +
                "RETURNING id, date::text AS date, mood, title, places, foods, memo, " +
                "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", " +
                "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"updatedAt\"",
              [id, date, mood, title, JSON.stringify(places), JSON.stringify(foods), memo]
            );
            if (rs.rows.length > 0) {
              resBody = rs.rows[0];
            } else {
              flag = 1;
              resStatus = 404;
              errMsg = "해당 코스를 찾을 수 없어요.";
            }
          }
        }
        else if (method == "DELETE") {
          // 삭제는 논리삭제(del_yn = 'Y') 로 처리함
          rs = await db.query("DELETE FROM courses WHERE id = $1 AND space_id IS NULL", [id]);
          if (rs.rowCount > 0) {
            resBody = { ok: true };
          } else {
            flag = 1;
            resStatus = 404;
            errMsg = "해당 코스를 찾을 수 없어요.";
          }
        }
      }
      else {
        flag = 1;
        resStatus = 404;
        errMsg = "지원하지 않는 요청입니다.";
      }
    } catch (e) {
      // 여기는 안탐
      console.error("API error", method, path, e);
      flag = 1;
      resStatus = 500;
      errMsg = "서버에서 오류가 발생했어요.";
    }

    // 커넥션 반납
    try {
      await db.end();
    } catch (e) {
      // 무시
    }

    if (flag == 1) {
      resBody = { error: errMsg };
    }

    // 응답 (XML -> JSON 변경됨)
    return new Response(JSON.stringify(resBody), {
      status: resStatus,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
};
