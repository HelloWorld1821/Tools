"""额度数据源：Codex 与 Antigravity。

每个 provider 的 fetch() 返回 ProviderResult，其中 windows 形如
{"5h": Window, "week": Window}，缺失的窗口表示暂未取到。
仅依赖标准库，所有网络/进程访问都只针对本机用户自己的账号与进程。
"""

from __future__ import annotations

import glob
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

FIVE_HOURS = 5 * 3600
ONE_WEEK = 7 * 24 * 3600
HTTP_TIMEOUT = 8

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


# ---------------------------------------------------------------- 工具函数

def clamp_pct(value: float) -> float:
    return max(0.0, min(100.0, float(value)))


def parse_time(value: Any) -> Optional[float]:
    """把 ISO 字符串 / 秒或毫秒时间戳 / {"seconds": n} 统一转成 Unix 秒。"""
    if value is None or value == "":
        return None
    if isinstance(value, dict) and "seconds" in value:
        return float(value["seconds"])
    if isinstance(value, (int, float)):
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

    def fetch(self) -> ProviderResult:
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


# ---------------------------------------------------------------- Antigravity

def parse_antigravity_status(data: Any, now: Optional[float] = None) -> dict:
    """在 GetUserStatus 响应中递归查找所有带 remainingFraction 的额度信息。"""
    now = now if now is not None else time.time()
    windows: dict = {}

    def visit(node: Any, hint: str) -> None:
        if isinstance(node, dict):
            if "remainingFraction" in node or ("resetTime" in node and hint.lower().endswith("quotainfo")):
                frac = float(node.get("remainingFraction", 0) or 0)
                reset_at = parse_time(node.get("resetTime"))
                win_secs = None
                for k in ("windowSeconds", "windowDuration", "periodSeconds"):
                    if k in node:
                        v = node[k]
                        win_secs = float(str(v).rstrip("s")) if v not in (None, "") else None
                key = None
                low = hint.lower()
                if "week" in low:
                    key = "week"
                elif "fivehour" in low or "5h" in low or "hourly" in low:
                    key = "5h"
                key = key or classify(win_secs, None if reset_at is None else reset_at - now)
                if key:
                    merge_min(windows, key, Window(clamp_pct(frac * 100), reset_at))
            for k, v in node.items():
                visit(v, str(k))
        elif isinstance(node, list):
            for item in node:
                visit(item, hint)

    visit(data, "")
    return windows


def parse_cmdline_args(cmdline: str) -> dict:
    args = {}
    for key in ("csrf_token", "extension_server_port"):
        m = re.search(rf"--{key}[=\s]+\"?([^\s\"]+)", cmdline)
        if m:
            args[key] = m.group(1)
    return args


def parse_netstat_ports(output: str, pid: int) -> list:
    ports = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING" \
                and parts[4] == str(pid):
            addr = parts[1]
            if addr.startswith(("127.0.0.1:", "[::1]:", "0.0.0.0:")):
                try:
                    ports.append(int(addr.rsplit(":", 1)[1]))
                except ValueError:
                    pass
    return sorted(set(ports))


class AntigravityProvider:
    name = "Antigravity"
    RPC = "/exa.language_server_pb.LanguageServerService/GetUserStatus"

    def fetch(self) -> ProviderResult:
        try:
            servers = self._find_servers()
        except Exception as exc:  # noqa: BLE001
            return ProviderResult(self.name, error=f"查找进程失败: {exc}")
        if not servers:
            return ProviderResult(self.name, error="未检测到运行中的 Antigravity")
        last_err = "未找到可用端口"
        for pid, args in servers:
            token = args.get("csrf_token", "")
            ports = self._listening_ports(pid)
            if args.get("extension_server_port"):
                ports.append(int(args["extension_server_port"]))
            for port in dict.fromkeys(ports):
                try:
                    data = self._call(port, token)
                except Exception as exc:  # noqa: BLE001
                    last_err = str(exc)
                    continue
                windows = parse_antigravity_status(data)
                if windows:
                    return ProviderResult(self.name, windows, source="本地服务")
                last_err = "响应中没有额度信息"
        return ProviderResult(self.name, error=last_err)

    def _find_servers(self) -> list:
        if sys.platform != "win32":
            out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True,
                                 timeout=10).stdout
            rows = [line.strip().split(None, 1) for line in out.splitlines() if line.strip()]
        else:
            ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                  "Get-CimInstance Win32_Process -Filter \"Name like 'language_server%'\" | "
                  "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress")
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True,
                                 encoding="utf-8", errors="replace", timeout=15,
                                 creationflags=_NO_WINDOW).stdout.strip()
            items = json.loads(out) if out else []
            items = items if isinstance(items, list) else [items]
            rows = [(str(i.get("ProcessId")), i.get("CommandLine") or "") for i in items]
        servers = []
        for row in rows:
            if len(row) != 2:
                continue
            pid, cmd = row
            if "language_server" in cmd and "antigravity" in cmd.lower() and "--csrf_token" in cmd:
                servers.append((int(pid), parse_cmdline_args(cmd)))
        return servers

    def _listening_ports(self, pid: int) -> list:
        if sys.platform != "win32":
            out = subprocess.run(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", str(pid)],
                                 capture_output=True, text=True, timeout=10).stdout
            return sorted({int(m) for m in re.findall(r":(\d+) \(LISTEN\)", out)})
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                             errors="replace", timeout=10, creationflags=_NO_WINDOW).stdout
        return parse_netstat_ports(out, pid)

    def _call(self, port: int, token: str) -> Any:
        body = json.dumps({"metadata": {"ideName": "antigravity", "extensionName": "antigravity",
                                        "locale": "zh-CN"}}).encode("utf-8")
        headers = {"Content-Type": "application/json", "Connect-Protocol-Version": "1",
                   "X-Codeium-Csrf-Token": token}
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # 本机服务使用自签名证书
        try:
            return _http_json(f"https://127.0.0.1:{port}{self.RPC}", headers, body, ctx)
        except (urllib.error.URLError, ssl.SSLError, ConnectionError):
            return _http_json(f"http://127.0.0.1:{port}{self.RPC}", headers, body)


PROVIDERS = (AntigravityProvider, CodexProvider)
