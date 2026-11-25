"""额度数据源：Antigravity (Gemini) 与 Codex。

每个 provider 的 fetch(force=False) 返回 ProviderResult，其中 windows 形如
{"5h": Window, "week": Window}，缺失的窗口表示暂未取到；
fetch_tasks() 返回 TaskStats（运行中/待操作任务数），无法获取时返回 None。
仅依赖标准库，所有网络/进程访问都只针对本机用户自己的账号与进程。
"""

from __future__ import annotations

import csv
import glob
import http.client
import json
import math
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

FIVE_HOURS = 5 * 3600
ONE_WEEK = 7 * 24 * 3600
HTTP_TIMEOUT = 8
LOCAL_HTTP_TIMEOUT = 4
LOCAL_TASK_TIMEOUT = 6
CODEX_FRESH_MTIME = 180
CODEX_RUNNING_MAX_AGE = 600
CODEX_WAITING_MAX_AGE = 3600
CODEX_UNFINISHED_MAX_AGE = 24 * 3600
AGY_DISCOVER_COOLDOWN = 15
AGY_TASK_REDISCOVER_SECONDS = 30
AGY_SERVICE = "/exa.language_server_pb.LanguageServerService/"

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


@dataclass
class Window:
    remaining: float  # 剩余百分比 0~100
    reset_at: Optional[float] = None  # Unix 时间戳

    def reset_in(self, now: Optional[float] = None) -> Optional[float]:
        if self.reset_at is None:
            return None
        return max(0.0, self.reset_at - (now if now is not None else time.time()))


@dataclass
class ProviderResult:
    name: str
    windows: dict = field(default_factory=dict)
    source: str = ""
    error: str = ""
    updated_at: float = field(default_factory=time.time)


@dataclass
class TaskStats:
    running: int = 0
    waiting: int = 0
    unfinished: int = 0
    waiting_titles: list[str] = field(default_factory=list)
    unfinished_titles: list[str] = field(default_factory=list)


def _append_title(dest: list[str], title: str, limit: int = 5) -> None:
    if title and title not in dest and len(dest) < limit:
        dest.append(title)


# ---------------------------------------------------------------- 工具函数

def clamp_pct(value: float) -> float:
    return max(0.0, min(100.0, float(value)))


def parse_fraction(value: Any) -> Optional[float]:
    """严格解析 0~1 的剩余额度比例，保留 0 并拒绝布尔值/空白/越界值。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        num = float(value)
    elif isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?", value):
        num = float(value)
    else:
        return None
    if not math.isfinite(num) or num < 0.0 or num > 1.0:
        return None
    return 0.0 if num == 0.0 else num


def parse_time(value: Any) -> Optional[float]:
    """把 ISO 字符串 / 秒或毫秒时间戳 / {"seconds": n} 统一转成 Unix 秒。"""
    if value is None or value == "":
        return None
    if isinstance(value, dict) and "seconds" in value:
        sec = value["seconds"]
        if isinstance(sec, bool) or sec is None:
            return None
        try:
            return float(sec)
        except (TypeError, ValueError):
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        v = float(value)
        return v / 1000.0 if v > 1e12 else v
    if isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"\d+(\.\d+)?", s):
            return parse_time(float(s))
        s = s.replace("Z", "+00:00")
        # Python 3.10 的 fromisoformat 只认 6 位小数
        s = re.sub(r"(\.\d{6})\d+", r"\1", s)
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return None


def _parse_reset_time(value: Any) -> Optional[float]:
    """解析 RetrieveUserQuotaSummary bucket 里的 resetTime，拒绝 0/空串等无效值。"""
    if isinstance(value, dict) and "seconds" in value:
        sec = parse_time(value)
        return sec if sec is not None and math.isfinite(sec) and sec > 0 else None
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", value):
        return parse_time(value)
    return None


def classify(window_seconds: Optional[float], reset_in: Optional[float]) -> Optional[str]:
    """根据窗口长度（优先）或距重置时间判断是 5h 还是周额度。"""
    if window_seconds:
        if window_seconds <= 6 * 3600:
            return "5h"
        if window_seconds >= 3 * 24 * 3600:
            return "week"
        return None
    if reset_in is not None:
        return "5h" if reset_in <= FIVE_HOURS + 300 else "week"
    return None


def merge_min(windows: dict, key: str, win: Window) -> None:
    """同一窗口出现多个额度池时，保留剩余最少的那个（真正的瓶颈）。"""
    cur = windows.get(key)
    if cur is None or win.remaining < cur.remaining:
        windows[key] = win


def _http_json(url: str, headers: dict, body: Optional[bytes] = None,
               context: Optional[ssl.SSLContext] = None) -> Any:
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=context) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _local_http_json(url: str, headers: dict, body: Optional[bytes] = None,
                     context: Optional[ssl.SSLContext] = None,
                     timeout: float = LOCAL_HTTP_TIMEOUT) -> Any:
    """直连本机回环地址，绕过系统代理环境变量/注册表代理。"""
    handlers: list[urllib.request.BaseHandler] = [urllib.request.ProxyHandler({})]
    if context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method="POST" if body is not None else "GET")
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------- Codex

def codex_home() -> str:
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def parse_codex_usage(data: dict) -> dict:
    """解析 chatgpt.com/backend-api/wham/usage 的响应。"""
    windows: dict = {}
    rate = (data or {}).get("rate_limit") or {}
    now = time.time()
    for slot in ("primary_window", "secondary_window"):
        w = rate.get(slot)
        if not isinstance(w, dict) or "used_percent" not in w:
            continue
        reset_at = parse_time(w.get("reset_at"))
        if reset_at is None and w.get("reset_after_seconds") is not None:
            reset_at = now + float(w["reset_after_seconds"])
        key = classify(w.get("limit_window_seconds"), None if reset_at is None else reset_at - now)
        key = key or ("5h" if slot == "primary_window" else "week")
        windows[key] = Window(clamp_pct(100 - float(w["used_percent"])), reset_at)
    return windows


def parse_codex_rate_limits(rate: dict, event_ts: Optional[float]) -> dict:
    """解析本地会话日志 token_count 事件里的 rate_limits 字段。"""
    windows: dict = {}
    base = event_ts or time.time()
    for slot in ("primary", "secondary"):
        w = rate.get(slot)
        if not isinstance(w, dict) or w.get("used_percent") is None:
            continue
        reset_at = parse_time(w.get("resets_at"))
        if reset_at is None and w.get("resets_in_seconds") is not None:
            reset_at = base + float(w["resets_in_seconds"])
        minutes = w.get("window_minutes")
        key = classify(minutes * 60 if minutes else None, None)
        key = key or ("5h" if slot == "primary" else "week")
        used = float(w["used_percent"])
        # 日志是历史快照：窗口已过重置时间则视为额度已恢复
        if reset_at is not None and reset_at <= time.time():
            used, reset_at = 0.0, None
        windows[key] = Window(clamp_pct(100 - used), reset_at)
    return windows


def latest_rate_limits_from_lines(lines: Iterable[str]) -> Optional[dict]:
    """在 jsonl 行中找最后一个带 rate_limits 的事件，返回窗口字典。"""
    found = None
    for line in lines:
        if "rate_limits" not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else obj
        rate = payload.get("rate_limits")
        if isinstance(rate, dict) and (rate.get("primary") or rate.get("secondary")):
            found = (rate, parse_time(obj.get("timestamp")))
    if not found:
        return None
    return parse_codex_rate_limits(*found)


class CodexProvider:
    name = "Codex"
    USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

    def fetch(self, force: bool = False) -> ProviderResult:
        del force  # Codex 每次直接拉取最新线上/日志数据
        errors = []
        try:
            windows = self._fetch_live()
            if windows:
                return ProviderResult(self.name, windows, source="在线")
        except Exception as exc:  # noqa: BLE001 - 失败后回退到本地日志
            errors.append(f"在线查询失败: {exc}")
        try:
            windows = self._fetch_logs()
            if windows:
                return ProviderResult(self.name, windows, source="本地日志")
            errors.append("会话日志中没有额度信息")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"读取日志失败: {exc}")
        return ProviderResult(self.name, error="；".join(errors))

    def _fetch_live(self) -> dict:
        path = os.path.join(codex_home(), "auth.json")
        if not os.path.exists(path):
            raise RuntimeError("未找到 auth.json，请先执行 codex login")
        with open(path, encoding="utf-8") as f:
            auth = json.load(f)
        tokens = auth.get("tokens") or {}
        token = tokens.get("access_token")
        if not token:
            raise RuntimeError("auth.json 中没有 ChatGPT 登录令牌")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json",
                   "User-Agent": "quota-float"}
        if tokens.get("account_id"):
            headers["ChatGPT-Account-Id"] = tokens["account_id"]
        return parse_codex_usage(_http_json(self.USAGE_URL, headers))

    def _fetch_logs(self) -> Optional[dict]:
        pattern = os.path.join(codex_home(), "sessions", "**", "rollout-*.jsonl")
        files = sorted(glob.glob(pattern, recursive=True), key=os.path.getmtime, reverse=True)
        for path in files[:20]:
            with open(path, encoding="utf-8", errors="ignore") as f:
                windows = latest_rate_limits_from_lines(f)
            if windows:
                return windows
        return None

    def _has_running_process(self) -> Optional[bool]:
        try:
            if sys.platform == "win32":
                out = subprocess.run(
                    ["tasklist", "/FO", "CSV", "/NH"],
                    capture_output=True, timeout=5, creationflags=_NO_WINDOW,
                ).stdout
                if parse_tasklist_has_codex(decode_windows_output(out)):
                    return True
                ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                      "Get-CimInstance Win32_Process | "
                      "Where-Object { $_.CommandLine -match '(?i)\\bcodex\\b' -and "
                      "$_.CommandLine -notmatch 'quota_float|providers\\.py' } | "
                      "Select-Object -First 1 ProcessId | ConvertTo-Json -Compress")
                proc = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                    capture_output=True, encoding="utf-8", errors="replace",
                    timeout=8, creationflags=_NO_WINDOW,
                )
                if proc.returncode != 0:
                    return None
                return bool(proc.stdout.lstrip("\ufeff").strip())
            out = subprocess.run(
                ["ps", "-eo", "comm="],
                capture_output=True, text=True, errors="replace", timeout=5,
            ).stdout
            return "codex" in out.lower()
        except (OSError, subprocess.SubprocessError):
            return None

    def fetch_tasks(self, now: Optional[float] = None, force: bool = False) -> Optional[TaskStats]:
        del force
        home = codex_home()
        if not os.path.isdir(home):
            return None
        now = now if now is not None else time.time()
        recent = _recent_codex_rollouts(home, CODEX_UNFINISHED_MAX_AGE, now=now, limit=30)
        if not recent:
            return TaskStats(0, 0, 0)

        running = 0
        waiting = 0
        unfinished = 0
        waiting_titles: list[str] = []
        unfinished_titles: list[str] = []
        demote_titles: list[str] = []
        any_fresh = False

        for mtime, path in recent:
            try:
                lines = _read_head_and_tail_lines(path)
            except OSError:
                continue
            age = max(0.0, now - mtime)
            state, is_subagent, title = parse_codex_session_state(lines)
            if state == "waiting":
                if age <= CODEX_WAITING_MAX_AGE:
                    waiting += 1
                    if age <= CODEX_FRESH_MTIME:
                        any_fresh = True
                    _append_title(waiting_titles, title)
                    _append_title(demote_titles, title)
                else:
                    unfinished += 1
                    _append_title(unfinished_titles, title)
            elif state == "running" and not is_subagent:
                if age <= CODEX_RUNNING_MAX_AGE:
                    running += 1
                    if age <= CODEX_FRESH_MTIME:
                        any_fresh = True
                    _append_title(demote_titles, title)
                else:
                    unfinished += 1
                    _append_title(unfinished_titles, title)
            elif state == "aborted" and not is_subagent:
                unfinished += 1
                _append_title(unfinished_titles, title)

        if (running > 0 or waiting > 0) and not any_fresh and self._has_running_process() is False:
            unfinished += running + waiting
            for t in demote_titles:
                _append_title(unfinished_titles, t)
            running = 0
            waiting = 0
            waiting_titles = []

        return TaskStats(
            running=running,
            waiting=waiting,
            unfinished=unfinished,
            waiting_titles=waiting_titles,
            unfinished_titles=unfinished_titles,
        )


def parse_tasklist_has_codex(output: str) -> bool:
    for row in csv.reader(output.splitlines()):
        if row and "codex" in row[0].lower():
            return True
    return False


_CODEX_WAIT_EVENTS = frozenset({
    "exec_approval_request",
    "apply_patch_approval_request",
    "request_user_input",
    "elicitation_request",
})
_CODEX_IN_TURN_EVENTS = frozenset({
    "task_started",
    "turn_started",
    "user_message",
    "agent_message",
    "agent_reasoning",
    "exec_command_begin",
    "exec_command_end",
    "patch_apply_begin",
    "patch_apply_end",
    "mcp_tool_call_begin",
    "mcp_tool_call_end",
    "item_started",
    "turn_diff",
    "web_search_begin",
    "web_search_end",
})
_CODEX_CLEAR_WAIT_EVENTS = frozenset({
    "task_started",
    "turn_started",
    "user_message",
    "agent_message",
    "agent_reasoning",
    "exec_command_begin",
    "exec_command_end",
    "patch_apply_begin",
    "patch_apply_end",
    "mcp_tool_call_begin",
    "mcp_tool_call_end",
    "item_started",
    "turn_diff",
    "web_search_begin",
    "web_search_end",
})
_CODEX_COMPLETE_EVENTS = frozenset({"task_complete", "turn_complete"})
_CODEX_ABORT_EVENTS = frozenset({"turn_aborted", "task_aborted", "turn_cancelled", "turn_canceled"})


def parse_codex_session_state(lines: Iterable[str]) -> tuple[str, bool, str]:
    """解析单个 Codex rollout jsonl，返回 (idle|running|waiting|aborted, is_subagent, title)。"""
    in_turn = False
    waiting = False
    aborted = False
    pending_user_calls: set[str] = set()
    is_subagent = False
    title = ""

    for line in lines:
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        kind = obj.get("type")
        payload = obj.get("payload")
        has_payload = isinstance(payload, dict)

        if kind == "session_meta" and has_payload:
            src = payload.get("source")
            if isinstance(src, dict) and ("subagent" in src or "thread_spawn" in src):
                is_subagent = True
        elif kind == "turn_context":
            in_turn = True
            aborted = False
        elif kind == "response_item" and has_payload:
            it = str(payload.get("type") or "").lower()
            if it in ("function_call", "custom_tool_call"):
                in_turn = True
                aborted = False
                name = str(payload.get("name") or "").lower()
                cid = str(payload.get("call_id") or "__anon__")
                if name in ("request_user_input", "ask_user_question", "ask_question"):
                    pending_user_calls.add(cid)
                else:
                    waiting = False
            elif it in ("function_call_output", "custom_tool_call_output"):
                in_turn = True
                aborted = False
                cid = str(payload.get("call_id") or "")
                pending_user_calls.discard(cid)
                pending_user_calls.discard("__anon__")
                waiting = False
            elif it in ("local_shell_call", "local_shell_call_output", "web_search_call", "reasoning"):
                in_turn = True
                aborted = False
                waiting = False
            elif it == "message":
                role = str(payload.get("role") or "").lower()
                phase = str(payload.get("phase") or "").lower()
                if role == "user":
                    in_turn = True
                    aborted = False
                    waiting = False
                elif role == "assistant" and phase == "final_answer":
                    in_turn = False
                    waiting = False
                    aborted = False
                    pending_user_calls.clear()
        elif kind == "event_msg" and has_payload or isinstance(kind, str):
            ev_obj = payload if (kind == "event_msg" and has_payload) else obj
            ev = str((ev_obj.get("type") if kind == "event_msg" else kind) or "").lower()
            if ev in ("", "token_count"):
                continue
            if ev in _CODEX_COMPLETE_EVENTS:
                in_turn = False
                waiting = False
                aborted = False
                pending_user_calls.clear()
            elif ev in _CODEX_ABORT_EVENTS:
                in_turn = False
                waiting = False
                aborted = True
                pending_user_calls.clear()
            elif ev in _CODEX_WAIT_EVENTS or "approval_request" in ev or "request_user_input" in ev:
                in_turn = True
                waiting = True
                aborted = False
            elif ev in _CODEX_IN_TURN_EVENTS:
                in_turn = True
                aborted = False
                if ev in _CODEX_CLEAR_WAIT_EVENTS:
                    waiting = False
                if ev == "user_message":
                    msg = ev_obj.get("message")
                    if isinstance(msg, str) and msg.strip():
                        title = re.sub(r"\s+", " ", msg).strip()[:36]

    if waiting or pending_user_calls:
        return "waiting", is_subagent, title
    if in_turn:
        return "running", is_subagent, title
    if aborted:
        return "aborted", is_subagent, title
    return "idle", is_subagent, title


def _read_head_and_tail_lines(path: str, tail_bytes: int = 512 * 1024) -> list[str]:
    size = os.path.getsize(path)
    if size <= tail_bytes:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read().splitlines()
    lines: list[str] = []
    with open(path, "rb") as f:
        head = f.readline(8192)
        if head:
            lines.append(head.decode("utf-8", errors="ignore"))
        f.seek(size - tail_bytes)
        f.readline()  # 丢弃可能被截断的首行
        tail = f.read().decode("utf-8", errors="ignore")
        lines.extend(tail.splitlines())
    return lines


def _recent_codex_rollouts(home: str, max_age: float, now: Optional[float] = None,
                           limit: int = 20) -> list[tuple[float, str]]:
    sessions_dir = os.path.join(home, "sessions")
    if not os.path.isdir(sessions_dir):
        return []
    now = now if now is not None else time.time()
    candidates: list[tuple[float, str]] = []
    stack = [sessions_dir]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.name.startswith("rollout-") and entry.name.endswith(".jsonl") and entry.is_file():
                        try:
                            mtime = entry.stat().st_mtime
                        except OSError:
                            continue
                        if (now - mtime) <= max_age:
                            candidates.append((mtime, entry.path))
        except OSError:
            continue

    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[:limit]


# ---------------------------------------------------------------- Antigravity

def _quota_group_kind(group_id: str, display_name: str) -> Optional[str]:
    value = f"{group_id} {display_name}"
    if re.search(r"(?:^|[^a-z])argon(?:$|[^a-z])", value, re.I):
        return "gemini-argon"
    if re.search(r"gemini|hydrogen|carbon|neon|orchestrator", value, re.I):
        return "gemini"
    if (re.search(r"claude|sonnet|opus|haiku|anthropic|gpt|openai|perplexity|fable", value, re.I)
            or re.search(r"(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])", value, re.I)
            or re.match(r"^3p(?:$|[-_])", group_id, re.I)):
        return "3p"
    return None


def _bucket_family(bucket: dict) -> str:
    bid = bucket.get("bucketId")
    return re.sub(r"-(5h|weekly)$", "", bid) if isinstance(bid, str) else ""


def _bucket_cadence(bucket: dict) -> Optional[str]:
    if "window" in bucket:
        win = bucket["window"]
        if win == "5h":
            return "5h"
        if win == "weekly":
            return "week"
        return None
    bid = bucket.get("bucketId")
    if isinstance(bid, str):
        m = re.search(r"-(5h|weekly)$", bid)
        if m:
            return "5h" if m.group(1) == "5h" else "week"
    return None


def parse_antigravity_quota_summary(data: Any, now: Optional[float] = None) -> dict:
    """解析 RetrieveUserQuotaSummary 响应，提取 Gemini 的 5h 与周额度。"""
    del now
    if not isinstance(data, dict):
        return {}
    root = data["response"] if isinstance(data.get("response"), dict) else data
    raw_groups = root.get("groups")
    groups = [g for g in raw_groups if isinstance(g, dict)] if isinstance(raw_groups, list) else []
    if not groups and isinstance(root.get("buckets"), list):
        families: dict[str, dict] = {}
        for idx, bucket in enumerate(root["buckets"]):
            if not isinstance(bucket, dict):
                continue
            key = _bucket_family(bucket) or f"group-{idx}"
            if key not in families:
                dname = bucket.get("displayName") if isinstance(bucket.get("displayName"), str) else key
                families[key] = {"displayName": dname, "buckets": []}
            families[key]["buckets"].append(bucket)
        groups = list(families.values())

    candidates: list[tuple[str, Optional[str], dict]] = []
    for group in groups:
        raw_buckets = group.get("buckets")
        buckets = [b for b in raw_buckets if isinstance(b, dict)] if isinstance(raw_buckets, list) else []
        group_id = next((_bucket_family(b) for b in buckets if _bucket_family(b)), "")
        display_name = group.get("displayName") if isinstance(group.get("displayName"), str) else ""
        windows: dict = {}
        for bucket in buckets:
            if bucket.get("disabled") is True:
                continue
            key = _bucket_cadence(bucket)
            if not key or key in windows:
                continue
            if "remainingFraction" in bucket:
                raw_frac = bucket["remainingFraction"]
            elif isinstance(bucket.get("remaining"), dict):
                raw_frac = bucket["remaining"].get("remainingFraction")
            else:
                raw_frac = None
            frac = parse_fraction(raw_frac)
            if frac is None:
                continue
            reset_at = _parse_reset_time(bucket.get("resetTime"))
            windows[key] = Window(clamp_pct(frac * 100.0), reset_at)
        if windows:
            candidates.append((group_id, _quota_group_kind(group_id, display_name), windows))

    for group_id, kind, windows in candidates:
        if kind == "gemini" and group_id.lower() == "gemini":
            return windows
    for _, kind, windows in candidates:
        if kind == "gemini":
            return windows
    for _, kind, windows in candidates:
        if kind == "gemini-argon":
            return windows
    return {}


def parse_antigravity_status(data: Any, now: Optional[float] = None) -> dict:
    """兼容旧版 GetUserStatus 响应，仅提取 Gemini 模型相关的额度信息。"""
    now = now if now is not None else time.time()
    windows: dict = {}

    target: Any = data
    if isinstance(data, dict):
        configs = ((data.get("userStatus") or {}).get("cascadeModelConfigData") or {}).get("clientModelConfigs")
        if isinstance(configs, list):
            gemini_cfgs = []
            for cfg in configs:
                if not isinstance(cfg, dict):
                    continue
                label = cfg.get("label") or ""
                alias = cfg.get("modelOrAlias")
                model_id = alias.get("model") if isinstance(alias, dict) else ""
                if _quota_group_kind(str(model_id or ""), str(label)) in ("gemini", "gemini-argon"):
                    gemini_cfgs.append(cfg)
            if gemini_cfgs:
                target = gemini_cfgs

    def visit(node: Any, hint: str) -> None:
        if isinstance(node, dict):
            if node.get("disabled") is True:
                return
            desc = " ".join(str(node.get(k) or "") for k in ("label", "displayName", "model", "bucketId"))
            if _quota_group_kind(str(node.get("bucketId") or ""), desc) == "3p":
                return
            has_frac = "remainingFraction" in node
            has_empty_quota = "resetTime" in node and hint.lower().endswith("quotainfo")
            if has_frac or has_empty_quota:
                frac = parse_fraction(node["remainingFraction"]) if has_frac else 0.0
                if frac is not None:
                    reset_at = parse_time(node.get("resetTime"))
                    win_secs = None
                    for k in ("windowSeconds", "windowDuration", "periodSeconds"):
                        if k in node:
                            v = node[k]
                            if v not in (None, ""):
                                try:
                                    win_secs = float(str(v).rstrip("s"))
                                except ValueError:
                                    win_secs = None
                    key = None
                    low = hint.lower()
                    if "week" in low:
                        key = "week"
                    elif "fivehour" in low or "5h" in low or "hourly" in low:
                        key = "5h"
                    key = key or classify(win_secs, None if reset_at is None else reset_at - now)
                    if key:
                        merge_min(windows, key, Window(clamp_pct(frac * 100.0), reset_at))
            for k, v in node.items():
                visit(v, str(k))
        elif isinstance(node, list):
            for item in node:
                visit(item, hint)

    visit(target, "")
    return windows


def parse_cmdline_args(cmdline: str) -> dict:
    args = {}
    for key in ("csrf_token", "extension_server_port", "app_data_dir"):
        m = re.search(rf"--{key}[=\s]+\"?([^\s\"]+)", cmdline)
        if m:
            args[key] = m.group(1)
    hub = re.search(r"--hub-port(?:=|\s+)[\"']?(\d+)", cmdline, re.I)
    if hub:
        args["hub_port"] = hub.group(1)
    return args


def is_standalone_cmdline(cmdline: str) -> bool:
    return bool(re.search(r"(?:^|\s)--standalone(?:\s|=|$)", cmdline or ""))


def _command_basename(cmd: str) -> str:
    s = (cmd or "").lstrip()
    if not s:
        return ""
    if s[0] in ("'", '"'):
        end = s.find(s[0], 1)
        token = s[1:end] if end != -1 else s[1:]
    else:
        token = s.split(None, 1)[0]
    return os.path.basename(token.replace("\\", "/"))


def is_antigravity_server(name: str, cmd: str) -> bool:
    """识别 Antigravity Desktop / IDE / hub 服务进程，排除纯 LSP。"""
    cmd_s = cmd or ""
    if re.search(r"(?:^|\s)[\"']?--enable_lsp(?:=|\s|$)", cmd_s, re.I):
        return False
    low_name = (name or "").lower()
    low_cmd = cmd_s.lower()
    if low_name in ("agy", "agy.exe"):
        return bool(re.search(r"(?:^|\s)[\"']?--hub(?:=|\s|$)", cmd_s, re.I))
    if "language_server" in low_name or "language_server" in low_cmd:
        return (
            is_standalone_cmdline(cmd_s)
            or bool(re.search(r"(?:^|\s)[\"']?--subclient_type(?:=|\s+)[\"']?ide[\"']?(?=\s|$)", cmd_s, re.I))
            or "antigravity" in low_cmd
            or "--csrf_token" in low_cmd
            or "--app_data_dir" in low_cmd
        )
    return False


def antigravity_log_candidates(home: Optional[str] = None, env: Optional[dict] = None,
                               platform: Optional[str] = None) -> list[str]:
    home = home or os.path.expanduser("~")
    env = os.environ if env is None else env
    platform = platform or sys.platform
    if platform == "win32":
        appdata = env.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        raw = [
            os.path.join(appdata, "Antigravity", "logs", "language_server.log"),
            os.path.join(home, ".gemini", "antigravity", "logs", "language_server.log"),
        ]
        profiles = [os.path.join(appdata, "Antigravity IDE"), os.path.join(appdata, "Antigravity")]
    elif platform == "darwin":
        app_sup = os.path.join(home, "Library", "Application Support")
        raw = [
            os.path.join(home, "Library", "Logs", "Antigravity", "language_server.log"),
            os.path.join(app_sup, "Antigravity", "logs", "language_server.log"),
        ]
        profiles = [os.path.join(app_sup, "Antigravity IDE"), os.path.join(app_sup, "Antigravity")]
    else:
        xdg = env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        raw = [
            os.path.join(xdg, "Antigravity", "logs", "language_server.log"),
            os.path.join(home, ".gemini", "antigravity", "logs", "language_server.log"),
        ]
        profiles = [os.path.join(xdg, "Antigravity IDE"), os.path.join(xdg, "Antigravity")]

    ide_logs: list[tuple[str, str]] = []
    for profile in profiles:
        logs_dir = os.path.join(profile, "logs")
        try:
            subdirs = sorted(
                (e.name for e in os.scandir(logs_dir)
                 if e.is_dir() and re.fullmatch(r"\d{8}T\d{6}", e.name)),
                reverse=True,
            )
        except OSError:
            continue
        for sub in subdirs[:4]:
            ide_logs.append((sub, os.path.join(logs_dir, sub, "ls-main.log")))
    ide_logs.sort(key=lambda item: item[0], reverse=True)
    raw.extend(path for _, path in ide_logs[:4])
    return list(dict.fromkeys(raw))


def parse_http_log_ports(text: str) -> list[int]:
    ports: list[int] = []
    for m in re.finditer(r"listening on random port at (\d+) for HTTP(?:\s|$)", text):
        port = int(m.group(1))
        if 1 <= port <= 65535:
            if port in ports:
                ports.remove(port)
            ports.append(port)
    ports.reverse()
    return ports


def read_log_http_ports(paths: Iterable[str]) -> list[int]:
    existing: list[tuple[float, str]] = []
    for path in paths:
        try:
            existing.append((os.path.getmtime(path), path))
        except OSError:
            continue
    existing.sort(key=lambda item: item[0], reverse=True)

    chunk_bytes = 256 * 1024
    overlap = 128
    max_scan = 16 * 1024 * 1024
    result: list[int] = []
    for _, path in existing:
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                end = f.tell()
                scanned = 0
                found: list[int] = []
                extra = 0
                while end > 0 and scanned < max_scan and len(found) < 8:
                    had_match = bool(found)
                    start = max(0, end - chunk_bytes)
                    f.seek(start)
                    data = f.read(end - start)
                    if not data:
                        break
                    for p in parse_http_log_ports(data.decode("utf-8", errors="ignore")):
                        if p not in found:
                            found.append(p)
                    if had_match:
                        extra += 1
                    if (found and extra >= 1) or start == 0:
                        break
                    scanned += len(data)
                    end = start + min(overlap, len(data) - 1)
                for p in found:
                    if p not in result:
                        result.append(p)
        except OSError:
            continue
    return result


def _valid_port(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 65535 else None


def resolve_daemon_credential(cmdline: str, pid: int, ports: Iterable[int] = (),
                              home: Optional[str] = None,
                              daemon_dir: Optional[str] = None) -> Optional[dict]:
    """从命令行或 Antigravity 2.34+ ~/.gemini/<app_data_dir>/daemon/*.json 获取 CSRF 凭据。"""
    args = parse_cmdline_args(cmdline or "")
    if args.get("csrf_token"):
        return {"csrf": args["csrf_token"], "http_port": None, "https_port": None}
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    if daemon_dir is None:
        home = home or os.path.expanduser("~")
        raw_app = args.get("app_data_dir") or "antigravity"
        app_dir = raw_app if re.fullmatch(r"[a-zA-Z0-9._-]+", raw_app) else "antigravity"
        daemon_dir = os.path.join(home, ".gemini", app_dir, "daemon")
    try:
        names = sorted(os.listdir(daemon_dir))
    except OSError:
        return None
    port_set = {p for p in (int(x) for x in ports) if 1 <= p <= 65535}
    fallback: Optional[dict] = None
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(daemon_dir, name), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or data.get("pid") != pid or isinstance(data.get("pid"), bool):
            continue
        csrf = data.get("csrfToken")
        if not isinstance(csrf, str) or not csrf:
            continue
        http_port = _valid_port(data.get("httpPort"))
        https_port = _valid_port(data.get("httpsPort"))
        entry = {"csrf": csrf, "http_port": http_port, "https_port": https_port}
        if (http_port and http_port in port_set) or (https_port and https_port in port_set):
            return entry
        if fallback is None:
            fallback = entry
    return fallback


_LOCAL_ADDRS = frozenset({
    "127.0.0.1", "0.0.0.0", "::1", "::",
    "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "localhost",
})
_UNSPEC_ADDRS = frozenset({"0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*"})


def _strip_addr(value: str) -> str:
    return value.strip().lower().strip("[]")


def _split_endpoint(value: str) -> Optional[tuple[str, str]]:
    m = re.fullmatch(r"(\[[^\]]+\]|[^:\s]+):(\d+|\*)", value.strip())
    return (m.group(1), m.group(2)) if m else None


def parse_netstat_snapshot(output: str) -> tuple[dict[int, list[int]], set[int]]:
    """解析 netstat 输出（兼容中文 Windows「侦听」），区分有效回环端口与 TUN 伪监听。"""
    ports_by_pid: dict[int, list[int]] = {}
    rejected_pids: set[int] = set()
    for line in output.splitlines():
        m = re.match(r"^\s*TCP\s+(\S+)\s+(\S+)\s+(?:LISTENING|LISTEN|侦听|监听)\s+(\d+)\s*$", line, re.I)
        if not m:
            continue
        pid = int(m.group(3))
        if not (1 <= pid <= 0xFFFFFFFF):
            continue
        local = _split_endpoint(m.group(1))
        remote = _split_endpoint(m.group(2))
        if (not local or not remote
                or _strip_addr(local[0]) not in _LOCAL_ADDRS
                or not local[1].isdigit() or not (1 <= int(local[1]) <= 65535)
                or _strip_addr(remote[0]) not in _UNSPEC_ADDRS
                or not (remote[1] == "0" or (remote[0] == "*" and remote[1] == "*"))):
            rejected_pids.add(pid)
            continue
        port = int(local[1])
        bucket = ports_by_pid.setdefault(pid, [])
        if port not in bucket:
            bucket.append(port)
    return {pid: sorted(ports) for pid, ports in ports_by_pid.items()}, rejected_pids


def parse_netstat_ports(output: str, pid: int) -> list[int]:
    ports_by_pid, _ = parse_netstat_snapshot(output)
    return ports_by_pid.get(pid, [])


def decode_windows_output(raw: bytes) -> str:
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        encoding = "mbcs" if sys.platform == "win32" else "utf-8"
        return raw.decode(encoding, errors="replace")


def probe_loopback_port(port: int, timeout: float = 0.4) -> bool:
    if isinstance(port, bool) or not isinstance(port, int) or not (1 <= port <= 65535):
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _strict_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def parse_net_tcp_connections(raw_json: str, pid: int, preferred_port: Optional[int] = None,
                              probe=probe_loopback_port) -> list[int]:
    """解析 Get-NetTCPConnection JSON 输出，兼容 TUN 驱动 State=0 与可探测的空 State。"""
    text = raw_json.lstrip("\ufeff").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except ValueError:
        return []
    rows = [data] if isinstance(data, dict) else (data if isinstance(data, list) else [])
    ports: list[int] = []
    uncertain_preferred = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        if _strict_int(row.get("OwningProcess")) != pid:
            continue
        port = _strict_int(row.get("LocalPort"))
        if port is None or not (1 <= port <= 65535):
            continue
        if _strip_addr(str(row.get("LocalAddress") or "")) not in _LOCAL_ADDRS:
            continue
        if _strip_addr(str(row.get("RemoteAddress") or "")) not in _UNSPEC_ADDRS:
            continue
        if _strict_int(row.get("RemotePort")) != 0:
            continue
        state = row.get("State")
        listen = (state in (2, "2", 0, "0") and not isinstance(state, bool)) or (
            isinstance(state, str) and bool(re.fullmatch(r"listen", state, re.I))
        )
        if listen:
            if port not in ports:
                ports.append(port)
        elif ("State" in row and state in (None, "")
              and preferred_port is not None and port == preferred_port):
            uncertain_preferred = True
    if uncertain_preferred and preferred_port is not None and preferred_port not in ports:
        if probe(preferred_port):
            ports.append(preferred_port)
    return ports


_AGY_SETTLED_STATUSES = frozenset({
    "", "IDLE", "DONE", "COMPLETED", "CANCELLED", "CANCELED",
    "STOPPED", "FAILED", "ERROR", "ARCHIVED", "UNSPECIFIED",
})
_AGY_UNFINISHED_STATUSES = frozenset({"PAUSED", "SUSPENDED", "SLEEPING", "INTERRUPTED"})
_AGY_STATE_RANK = {"idle": 0, "unfinished": 1, "running": 2, "waiting": 3}


def _step_is_settled(step: Any) -> bool:
    if not isinstance(step, dict):
        return False
    st = re.sub(r"^CORTEX_STEP_STATUS_", "", str(step.get("status") or "").strip().upper())
    return bool(re.fullmatch(r"DONE|COMPLETED|CANCELLED|CANCELED|ERROR|FAILED", st))


def _trajectory_state(entry: dict) -> str:
    waiting_steps = entry.get("waitingSteps")
    if isinstance(waiting_steps, list) and any(not _step_is_settled(s) for s in waiting_steps):
        return "waiting"
    raw_status = entry.get("status")
    if isinstance(raw_status, int) and not isinstance(raw_status, bool):
        if raw_status == 3:
            return "waiting"
        if raw_status == 2:
            return "running"
    else:
        st = re.sub(r"^CASCADE_RUN_STATUS_", "", str(raw_status or "").strip().upper())
        if re.search(r"WAIT|APPROV|PENDING_USER|NEEDS_USER", st):
            return "waiting"
        if st in _AGY_UNFINISHED_STATUSES:
            return "unfinished"
        if st not in _AGY_SETTLED_STATUSES:
            return "running"
    if entry.get("hasRunningSubagents") is True:
        return "running"
    if entry.get("hasActiveChildren") is True or entry.get("notFullyIdle") is True:
        return "unfinished"
    return "idle"


def _extract_summaries_map(data: Any) -> Optional[dict]:
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("trajectorySummaries"), dict):
        return data["trajectorySummaries"]
    resp = data.get("response")
    if isinstance(resp, dict) and isinstance(resp.get("trajectorySummaries"), dict):
        return resp["trajectorySummaries"]
    return {}


def merge_antigravity_summaries(summary_maps: Iterable[dict]) -> dict:
    """合并多个 Antigravity 服务返回的 trajectorySummaries，同 ID 取更活跃状态。"""
    merged: dict[str, dict] = {}
    for smap in summary_maps:
        if not isinstance(smap, dict):
            continue
        for raw_cid, entry in smap.items():
            if not isinstance(entry, dict):
                continue
            cid = str(raw_cid).lower()
            cur = merged.get(cid)
            if cur is None:
                merged[cid] = entry
                continue
            new_key = (_AGY_STATE_RANK[_trajectory_state(entry)], _strict_int(entry.get("stepCount")) or 0)
            cur_key = (_AGY_STATE_RANK[_trajectory_state(cur)], _strict_int(cur.get("stepCount")) or 0)
            if new_key > cur_key:
                merged[cid] = entry
    return merged


def parse_antigravity_tasks(data: Any) -> TaskStats:
    """解析 GetAllCascadeTrajectories 响应，统计运行中、待操作与未结束根任务数。"""
    if not isinstance(data, dict):
        return TaskStats()
    raw = data.get("trajectorySummaries")
    if raw is None and isinstance(data.get("response"), dict):
        raw = data["response"].get("trajectorySummaries")
    if not isinstance(raw, dict):
        return TaskStats()

    entries = {str(k).lower(): v for k, v in raw.items() if isinstance(v, dict)}
    root_states: dict[str, str] = {}
    root_summaries: dict[str, str] = {}

    for cid, entry in entries.items():
        meta = entry.get("trajectoryMetadata")
        meta = meta if isinstance(meta, dict) else {}
        src = meta.get("sourceMetadata")
        src = src if isinstance(src, dict) else {}
        is_sidecar = bool(src.get("sidecar"))
        hide = src.get("hideFromConversationList") is True

        root_id = cid
        seen = {cid}
        for _ in range(16):
            cur = entries.get(root_id)
            if not isinstance(cur, dict):
                break
            c_meta = cur.get("trajectoryMetadata")
            c_meta = c_meta if isinstance(c_meta, dict) else {}
            c_src = c_meta.get("sourceMetadata")
            c_src = c_src if isinstance(c_src, dict) else {}
            nxt_raw = (c_meta.get("rootConversationId")
                       or c_src.get("rootConversationId")
                       or c_meta.get("parentConversationId"))
            if not isinstance(nxt_raw, str) or not nxt_raw.strip():
                break
            nxt = nxt_raw.strip().lower()
            if nxt in seen:
                break
            seen.add(nxt)
            root_id = nxt

        root_entry = entries.get(root_id)
        root_meta = root_entry.get("trajectoryMetadata") if isinstance(root_entry, dict) else None
        root_src = root_meta.get("sourceMetadata") if isinstance(root_meta, dict) else None
        root_sidecar = isinstance(root_src, dict) and bool(root_src.get("sidecar"))

        if is_sidecar or root_sidecar or (root_id == cid and hide):
            continue

        state = _trajectory_state(entry)
        prev = root_states.get(root_id, "idle")
        if _AGY_STATE_RANK[state] > _AGY_STATE_RANK[prev] or root_id not in root_states:
            root_states[root_id] = state

        if root_id not in root_summaries:
            title_src = root_entry if isinstance(root_entry, dict) else entry
            raw_title = title_src.get("summary")
            if isinstance(raw_title, str) and raw_title.strip():
                root_summaries[root_id] = re.sub(r"\s+", " ", raw_title).strip()[:36]

    running = 0
    waiting = 0
    unfinished = 0
    waiting_titles: list[str] = []
    unfinished_titles: list[str] = []
    for rid, st in root_states.items():
        if st == "waiting":
            waiting += 1
            _append_title(waiting_titles, root_summaries.get(rid, ""))
        elif st == "running":
            running += 1
        elif st == "unfinished":
            unfinished += 1
            _append_title(unfinished_titles, root_summaries.get(rid, ""))

    return TaskStats(
        running=running,
        waiting=waiting,
        unfinished=unfinished,
        waiting_titles=waiting_titles,
        unfinished_titles=unfinished_titles,
    )


class AntigravityProvider:
    name = "Antigravity (Gemini)"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._endpoint: Optional[tuple[int, str, bool]] = None
        self._task_endpoints: dict[int, tuple[int, str, bool]] = {}
        self._task_discover_at: float = 0.0
        self._discover_fail_until: float = 0.0

    def _discover_server_endpoints(self, respect_cooldown: bool = False) -> tuple[list[tuple[int, list[tuple[int, str, bool]]]], str]:
        if respect_cooldown:
            with self._lock:
                if time.time() < self._discover_fail_until:
                    return [], "未检测到运行中的 Antigravity"

        servers = self._find_servers()
        if not servers:
            with self._lock:
                self._discover_fail_until = time.time() + AGY_DISCOVER_COOLDOWN
            return [], "未检测到运行中的 Antigravity"

        log_ports = self._read_log_ports()
        preferred_port = log_ports[0] if log_ports else None
        per_server: list[tuple[int, list[tuple[int, str, bool]]]] = []
        last_err = "未找到可用端口"

        for pid, cmd, args in servers:
            hub_port = int(args["hub_port"]) if args.get("hub_port", "").isdigit() else None
            pref = hub_port or preferred_port
            live_ports = self._listening_ports(pid, preferred_port=pref)
            cred = self._resolve_daemon(cmd, pid, live_ports)
            if cred and cred.get("http_port") and cred["http_port"] not in live_ports:
                for p in self._listening_ports(pid, preferred_port=cred["http_port"]):
                    if p not in live_ports:
                        live_ports.append(p)
            if not cred or not cred.get("csrf"):
                last_err = "未找到本地接口凭据"
                continue

            token = cred["csrf"]
            cands: list[tuple[int, str, bool]] = []
            seen_ports: set[int] = set()

            def add_cand(port: Optional[int], prefer_http: bool) -> None:
                if port and 1 <= port <= 65535 and port not in seen_ports:
                    seen_ports.add(port)
                    cands.append((port, token, prefer_http))

            live_set = set(live_ports)
            if hub_port and hub_port in live_set:
                add_cand(hub_port, True)
            for p in log_ports:
                if p in live_set:
                    add_cand(p, True)
            add_cand(cred.get("http_port") if cred.get("http_port") in live_set else None, True)
            add_cand(cred.get("https_port") if cred.get("https_port") in live_set else None, False)
            for p in live_ports:
                add_cand(p, True)
            if args.get("extension_server_port", "").isdigit():
                add_cand(int(args["extension_server_port"]), False)
            if not live_ports:
                if hub_port:
                    add_cand(hub_port, True)
                add_cand(cred.get("http_port"), True)
                for p in log_ports[:3]:
                    add_cand(p, True)
                add_cand(cred.get("https_port"), False)

            if cands:
                per_server.append((pid, cands))

        with self._lock:
            self._discover_fail_until = 0.0 if per_server else time.time() + AGY_DISCOVER_COOLDOWN
        return per_server, ("" if per_server else last_err)

    def _discover_endpoints(self, respect_cooldown: bool = False) -> tuple[list[tuple[int, str, bool]], str]:
        per_server, err = self._discover_server_endpoints(respect_cooldown=respect_cooldown)
        endpoints: list[tuple[int, str, bool]] = []
        for _, cands in per_server:
            endpoints.extend(cands)
        return endpoints, err

    def _fetch_on_endpoint(self, port: int, token: str, prefer_http: bool,
                           summary_payload: dict, status_payload: dict) -> tuple[Optional[dict], str, bool]:
        fallback_status = False
        last_err = "未找到可用端口"
        try:
            data = self._call_rpc(port, token, "RetrieveUserQuotaSummary",
                                  summary_payload, prefer_http=prefer_http)
            windows = parse_antigravity_quota_summary(data)
            if windows:
                return windows, "", False
            last_err = "响应中没有 Gemini 额度信息"
            fallback_status = True
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                return None, f"HTTP {exc.code}", True
            last_err = f"HTTP {exc.code}"
            fallback_status = True
        except Exception as exc:  # noqa: BLE001
            return None, str(exc), True

        if fallback_status:
            try:
                status_data = self._call_rpc(port, token, "GetUserStatus",
                                             status_payload, prefer_http=prefer_http)
                windows = parse_antigravity_status(status_data)
                if windows:
                    return windows, "", False
                return None, "响应中没有 Gemini 额度信息", False
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    return None, f"HTTP {exc.code}", True
                return None, last_err or f"HTTP {exc.code}", False
            except Exception as exc:  # noqa: BLE001
                return None, last_err or str(exc), True
        return None, last_err, False

    def fetch(self, force: bool = False) -> ProviderResult:
        summary_payload = {"forceRefresh": True} if force else {}
        status_payload = {"metadata": {"ideName": "antigravity", "extensionName": "antigravity",
                                       "locale": "zh-CN"}}

        with self._lock:
            cached = self._endpoint

        last_err = "未找到可用端口"
        if cached is not None:
            windows, err, failed = self._fetch_on_endpoint(
                cached[0], cached[1], cached[2], summary_payload, status_payload,
            )
            if windows:
                return ProviderResult(self.name, windows, source="本地服务")
            last_err = err
            if failed:
                with self._lock:
                    if self._endpoint == cached:
                        self._endpoint = None

        try:
            endpoints, disc_err = self._discover_endpoints(respect_cooldown=False)
        except Exception as exc:  # noqa: BLE001
            return ProviderResult(self.name, error=f"查找进程失败: {exc}")

        if not endpoints:
            return ProviderResult(self.name, error=disc_err or last_err)

        for ep in endpoints:
            if ep == cached:
                continue
            windows, err, _ = self._fetch_on_endpoint(
                ep[0], ep[1], ep[2], summary_payload, status_payload,
            )
            if windows:
                with self._lock:
                    self._endpoint = ep
                return ProviderResult(self.name, windows, source="本地服务")
            last_err = err

        return ProviderResult(self.name, error=last_err)

    def fetch_tasks(self, force: bool = False) -> Optional[TaskStats]:
        with self._lock:
            cached_map = dict(self._task_endpoints)
            discover_at = self._task_discover_at

        if not force and cached_map and (time.time() - discover_at) < AGY_TASK_REDISCOVER_SECONDS:
            collected: list[dict] = []
            need_rediscover = False
            for pid, ep in cached_map.items():
                port, token, prefer_http = ep
                try:
                    data = self._call_rpc(
                        port, token, "GetAllCascadeTrajectories",
                        {"excludeSubtrajectories": False},
                        prefer_http=prefer_http, timeout=LOCAL_TASK_TIMEOUT,
                    )
                    smap = _extract_summaries_map(data)
                    if smap is not None:
                        collected.append(smap)
                except urllib.error.HTTPError as exc:
                    if exc.code in (401, 403):
                        need_rediscover = True
                        with self._lock:
                            if self._task_endpoints.get(pid) == ep:
                                self._task_endpoints.pop(pid, None)
                except Exception:  # noqa: BLE001
                    need_rediscover = True
                    with self._lock:
                        if self._task_endpoints.get(pid) == ep:
                            self._task_endpoints.pop(pid, None)

            if not need_rediscover:
                if not collected:
                    return None
                return parse_antigravity_tasks({"trajectorySummaries": merge_antigravity_summaries(collected)})

        try:
            server_cands, _ = self._discover_server_endpoints(respect_cooldown=not force)
        except Exception:  # noqa: BLE001
            return None

        with self._lock:
            self._task_discover_at = time.time()
            prev_map = dict(self._task_endpoints)

        new_map: dict[int, tuple[int, str, bool]] = {}
        collected = []
        for pid, cands in server_cands:
            ordered: list[tuple[int, str, bool]] = []
            prev_ep = prev_map.get(pid)
            if prev_ep is not None:
                ordered.append(prev_ep)
            for ep in cands:
                if ep not in ordered:
                    ordered.append(ep)
            for ep in ordered:
                port, token, prefer_http = ep
                try:
                    data = self._call_rpc(
                        port, token, "GetAllCascadeTrajectories",
                        {"excludeSubtrajectories": False},
                        prefer_http=prefer_http, timeout=LOCAL_TASK_TIMEOUT,
                    )
                    smap = _extract_summaries_map(data)
                    if smap is None:
                        continue
                    collected.append(smap)
                    new_map[pid] = ep
                    with self._lock:
                        if self._endpoint is None:
                            self._endpoint = ep
                    break
                except Exception:  # noqa: BLE001
                    continue

        with self._lock:
            self._task_endpoints = new_map

        if not collected:
            return None
        return parse_antigravity_tasks({"trajectorySummaries": merge_antigravity_summaries(collected)})

    def _read_log_ports(self) -> list[int]:
        return read_log_http_ports(antigravity_log_candidates())

    def _resolve_daemon(self, cmdline: str, pid: int, ports: Iterable[int]) -> Optional[dict]:
        return resolve_daemon_credential(cmdline, pid, ports=ports)

    def _find_servers(self) -> list[tuple[int, str, dict]]:
        if sys.platform != "win32":
            out = subprocess.run(["ps", "-ww", "-axo", "pid=,args="], capture_output=True,
                                 text=True, errors="replace", timeout=10).stdout
            raw_rows: list[tuple[str, str, str]] = []
            for line in out.splitlines():
                parts = line.strip().split(None, 1)
                if len(parts) == 2:
                    raw_rows.append((parts[0], _command_basename(parts[1]), parts[1]))
        else:
            ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                  "Get-CimInstance Win32_Process -Filter \"Name like 'language_server%' or Name='agy.exe'\" | "
                  "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress")
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True,
                                 encoding="utf-8", errors="replace", timeout=15,
                                 creationflags=_NO_WINDOW).stdout.lstrip("\ufeff").strip()
            items = json.loads(out) if out else []
            items = items if isinstance(items, list) else [items]
            raw_rows = [
                (str(i.get("ProcessId")), str(i.get("Name") or ""), i.get("CommandLine") or "")
                for i in items if isinstance(i, dict)
            ]

        scored: list[tuple[int, int, str, dict]] = []
        for pid_str, name, cmd in raw_rows:
            if not pid_str.isdigit() or not is_antigravity_server(name, cmd):
                continue
            low_name = name.lower()
            low_cmd = cmd.lower()
            if is_standalone_cmdline(cmd):
                pri = 0
            elif low_name in ("agy", "agy.exe") and re.search(r"(?:^|\s)[\"']?--hub(?:=|\s|$)", cmd, re.I):
                pri = 1
            elif re.search(r"(?:^|\s)[\"']?--subclient_type(?:=|\s+)[\"']?ide[\"']?(?=\s|$)", low_cmd):
                pri = 2
            else:
                pri = 3
            scored.append((pri, int(pid_str), cmd, parse_cmdline_args(cmd)))
        scored.sort(key=lambda item: (item[0], item[1]))
        return [(pid, cmd, args) for _, pid, cmd, args in scored]

    def _listening_ports(self, pid: int, preferred_port: Optional[int] = None) -> list[int]:
        if sys.platform != "win32":
            out = subprocess.run(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", str(pid), "-Fpn"],
                                 capture_output=True, text=True, errors="replace", timeout=10).stdout
            ports = []
            for line in out.splitlines():
                m = re.match(r"^n.+:(\d+)(?:\s|$)", line)
                if m:
                    p = int(m.group(1))
                    if p not in ports:
                        ports.append(p)
            return sorted(ports)

        raw = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                             timeout=10, creationflags=_NO_WINDOW).stdout
        ports_by_pid, rejected_pids = parse_netstat_snapshot(decode_windows_output(raw))
        ports = list(ports_by_pid.get(pid, []))
        need_fallback = (
            not ports
            or (preferred_port is not None and preferred_port not in ports)
            or pid in rejected_pids
        )
        if need_fallback:
            ps = (f"[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                  f"Get-NetTCPConnection -OwningProcess {int(pid)} -ErrorAction SilentlyContinue | "
                  f"Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State | "
                  f"ConvertTo-Json -Compress")
            try:
                out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                                     capture_output=True, encoding="utf-8", errors="replace",
                                     timeout=8, creationflags=_NO_WINDOW).stdout
                for p in parse_net_tcp_connections(out, pid, preferred_port=preferred_port):
                    if p not in ports:
                        ports.append(p)
            except (OSError, subprocess.SubprocessError):
                pass
        return ports

    def _call_rpc(self, port: int, token: str, method: str, payload: dict,
                  prefer_http: bool = True, timeout: float = LOCAL_HTTP_TIMEOUT) -> Any:
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-codeium-csrf-token": token,
        }
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # 本机服务使用自签名证书
        http_url = f"http://127.0.0.1:{port}{AGY_SERVICE}{method}"
        https_url = f"https://127.0.0.1:{port}{AGY_SERVICE}{method}"

        if prefer_http:
            try:
                return _local_http_json(http_url, headers, body, timeout=timeout)
            except urllib.error.HTTPError as exc:
                if exc.code != 400:
                    raise
                return _local_http_json(https_url, headers, body, ctx, timeout=timeout)
            except (urllib.error.URLError, OSError, http.client.HTTPException):
                return _local_http_json(https_url, headers, body, ctx, timeout=timeout)

        try:
            return _local_http_json(https_url, headers, body, ctx, timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except (ssl.SSLError, urllib.error.URLError, OSError, http.client.HTTPException):
            return _local_http_json(http_url, headers, body, timeout=timeout)


PROVIDERS = (AntigravityProvider, CodexProvider)


def _rollout_event_tags(lines: Iterable[str], limit: int = 3) -> list[str]:
    tags: list[str] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        kind = obj.get("type")
        payload = obj.get("payload")
        if kind in ("event_msg", "response_item") and isinstance(payload, dict):
            sub = payload.get("type")
            tag = f"{kind}:{sub}" if sub else str(kind)
            if kind == "response_item" and payload.get("name"):
                tag += f"({payload['name']})"
        else:
            tag = str(kind or "unknown")
        tags.append(tag)
    return tags[-limit:]


def run_diagnose() -> None:
    """输出脱敏诊断信息（不含令牌、提示词或对话文本）。"""
    ag = AntigravityProvider()
    print("[Antigravity]")
    try:
        servers = ag._find_servers()
        flags_summary = []
        for pid, cmd, args in servers:
            flags = []
            if is_standalone_cmdline(cmd):
                flags.append("standalone")
            if re.search(r"(?:^|\s)[\"']?--hub(?:=|\s|$)", cmd, re.I):
                flags.append("hub")
            if re.search(r"(?:^|\s)[\"']?--subclient_type(?:=|\s+)[\"']?ide[\"']?(?=\s|$)", cmd, re.I):
                flags.append("ide")
            if args.get("hub_port"):
                flags.append(f"hub_port={args['hub_port']}")
            flags_summary.append((pid, flags or ["other"]))
        print(f"  servers: {flags_summary}")
    except Exception as exc:  # noqa: BLE001
        print(f"  servers error: {exc}")

    try:
        per_server, err = ag._discover_server_endpoints(respect_cooldown=False)
        if err:
            print(f"  discovery note: {err}")
        for pid, cands in per_server:
            ports = [p for p, _, _ in cands]
            print(f"  pid={pid} candidate_ports={ports}")
            for port, token, prefer_http in cands:
                try:
                    data = ag._call_rpc(
                        port, token, "GetAllCascadeTrajectories",
                        {"excludeSubtrajectories": False},
                        prefer_http=prefer_http, timeout=LOCAL_TASK_TIMEOUT,
                    )
                    smap = _extract_summaries_map(data)
                    if smap is None:
                        continue
                    non_idle = []
                    for entry in smap.values():
                        if not isinstance(entry, dict):
                            continue
                        st = _trajectory_state(entry)
                        if st != "idle":
                            ws = entry.get("waitingSteps")
                            non_idle.append((
                                st,
                                entry.get("status"),
                                len(ws) if isinstance(ws, list) else 0,
                                bool(entry.get("hasRunningSubagents")),
                                bool(entry.get("hasActiveChildren")),
                                bool(entry.get("notFullyIdle")),
                            ))
                    print(f"    port={port} total={len(smap)} non_idle={non_idle[:20]}")
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f"    port={port} err={exc}")
        ts_ag = ag.fetch_tasks(force=True)
        if ts_ag is None:
            print("  stats: None")
        else:
            print(f"  stats: running={ts_ag.running} waiting={ts_ag.waiting} unfinished={ts_ag.unfinished}")
    except Exception as exc:  # noqa: BLE001
        print(f"  diagnose error: {exc}")

    print("[Codex]")
    home = codex_home()
    exists = os.path.isdir(home)
    print(f"  codex_home exists={exists}")
    if exists:
        now = time.time()
        try:
            recent = _recent_codex_rollouts(home, CODEX_UNFINISHED_MAX_AGE, now=now, limit=30)
            print(f"  recent_rollouts_24h={len(recent)}")
            for mtime, path in recent[:15]:
                try:
                    size = os.path.getsize(path)
                    lines = _read_head_and_tail_lines(path)
                    state, is_subagent, _ = parse_codex_session_state(lines)
                    tags = _rollout_event_tags(lines)
                    print(f"    age={int(now - mtime)}s size={size} tags={tags} state={state} sub={is_subagent}")
                except OSError as exc:
                    print(f"    read err={exc}")
        except Exception as exc:  # noqa: BLE001
            print(f"  rollouts error: {exc}")
        cx = CodexProvider()
        print(f"  has_running_process={cx._has_running_process()}")
        ts_cx = cx.fetch_tasks(now=now, force=True)
        if ts_cx is None:
            print("  stats: None")
        else:
            print(f"  stats: running={ts_cx.running} waiting={ts_cx.waiting} unfinished={ts_cx.unfinished}")


if __name__ == "__main__":
    if "--diagnose" in sys.argv[1:]:
        run_diagnose()
