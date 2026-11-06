"""PreToolUse 훅: .env 파일을 고치는 도구 호출을 막는다.

- Write / Edit / MultiEdit / NotebookEdit: 대상 파일 이름이 .env 또는 .env.* 이면 거부
- Bash / PowerShell: 명령이 .env 파일을 가리키면서 쓰기·삭제·이동 동작을 하면 거부
- .env.example / .env.sample / .env.template 는 비밀값이 없는 견본이라 허용

거부할 때는 permissionDecision "deny" JSON 을 출력하고 0 으로 끝낸다.
"""
import json
import os
import re
import sys

ALLOWED = {".env.example", ".env.sample", ".env.template"}
ENV_NAME = re.compile(r"^\.env(\..+)?$", re.IGNORECASE)

# 명령 안에서 .env 파일을 가리키는 토큰 (경로 구분자나 따옴표 뒤, 또는 맨 앞)
ENV_TOKEN = re.compile(r"""(?:^|[\s"'=/\\>])(\.env(?:\.[\w.-]+)?)(?=$|[\s"';|&)<>])""", re.IGNORECASE)
# 파일을 바꾸는 동작
WRITE_OPS = re.compile(
    r"(>>?|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-[a-z]*i|\btruncate\b|\btouch\b"
    r"|\b(rm|mv|cp|ln|dd|install)\b"
    r"|\b(Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item)\b"
    r"|\b(sc|ac|del|erase|ren|move|copy)\b"
    r"|WriteAllText|AppendAllText|WriteAllLines|AppendAllLines)",
    re.IGNORECASE,
)


def is_protected(path: str) -> bool:
    name = os.path.basename(path.replace("\\", "/"))
    return bool(ENV_NAME.match(name)) and name.lower() not in ALLOWED


def deny(reason: str) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=True))
    sys.exit(0)


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return  # 형식이 이상하면 판단하지 않고 통과시킨다
    tool = data.get("tool_name", "")
    tin = data.get("tool_input") or {}

    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        path = tin.get("file_path") or tin.get("notebook_path") or ""
        if path and is_protected(path):
            deny(f".env 파일은 수정할 수 없습니다 ({os.path.basename(path)}). 값을 바꾸려면 사용자가 직접 고쳐 주세요.")
        return

    if tool in ("Bash", "PowerShell"):
        cmd = tin.get("command") or ""
        targets = [t for t in ENV_TOKEN.findall(cmd) if t.lower() not in ALLOWED]
        if targets and WRITE_OPS.search(cmd):
            deny(f"명령이 .env 파일({targets[0]})을 바꾸려고 해서 막았습니다. 값을 바꾸려면 사용자가 직접 고쳐 주세요.")


if __name__ == "__main__":
    main()
