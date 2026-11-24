"""桌面半透明悬浮框：显示 Antigravity 与 Codex 的 5h / 周剩余额度。

双击运行（.pyw 不弹控制台）。左键拖动，双击立即刷新，右键菜单可切换置顶、
开机自启或退出。窗口位置保存在同目录的 config.json。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import tkinter as tk

from providers import PROVIDERS, ProviderResult

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
DEFAULTS = {"x": None, "y": 80, "alpha": 0.82, "refresh_seconds": 120, "topmost": True}
WINDOW_LABELS = (("5h", "5h"), ("week", "周"))
BAR_W, BAR_H = 120, 6

THEMES = {
    "dark": {"bg": "#1e1f24", "fg": "#e8e8ec", "sub": "#9a9ca6", "track": "#3a3c44",
             "ok": "#4cc38a", "warn": "#f0b429", "bad": "#ef5a5a"},
    "light": {"bg": "#f7f7f9", "fg": "#1f2328", "sub": "#5f6470", "track": "#d9dbe0",
              "ok": "#1f8f55", "warn": "#b7791f", "bad": "#c53030"},
}


def system_theme() -> str:
    """跟随 Windows 应用浅色/深色设置，读取失败时默认深色。"""
    if sys.platform != "win32":
        return "dark"
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        light, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        return "light" if light else "dark"
    except OSError:
        return "dark"


def fmt_duration(seconds) -> str:
    if seconds is None or seconds <= 0:
        return ""
    if seconds < 60:
        return "<1分"
    seconds = int(seconds)
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d:
        return f"{d}天{h}时"
    if h:
        return f"{h}时{m:02d}分"
    return f"{m}分"


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def startup_script_path() -> str:
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(appdata, r"Microsoft\Windows\Start Menu\Programs\Startup", "quota-float.vbs")


class QuotaFloat:
    def __init__(self) -> None:
        self.cfg = load_config()
        self.colors = THEMES[system_theme()]
        self.results: dict = {}
        self.fetching = False
        self._status_text = "正在获取…"

        self.root = tk.Tk()
        self.root.title("Quota Float")
        self.root.overrideredirect(True)
        self.root.attributes("-alpha", float(self.cfg["alpha"]))
        self.root.attributes("-topmost", bool(self.cfg["topmost"]))
        self.root.configure(bg=self.colors["bg"])

        self.frame = tk.Frame(self.root, bg=self.colors["bg"], padx=12, pady=8)
        self.frame.pack(fill="both", expand=True)
        self.rows: dict = {}
        for r, provider in enumerate(PROVIDERS):
            self._build_section(provider.name, r)
        self.status = tk.Label(self.frame, text="正在获取…", font=("Microsoft YaHei UI", 8),
                               bg=self.colors["bg"], fg=self.colors["sub"], anchor="w")
        self.status.grid(row=len(PROVIDERS) * 3, column=0, columnspan=3, sticky="w", pady=(4, 0))

        self._build_menu()
        self._bind_drag(self.root)
        self._place_window()
        self.refresh()
        self._tick()

    # ---------------------------------------------------------- 布局
    def _build_section(self, name: str, index: int) -> None:
        c = self.colors
        base = index * 3
        title = tk.Label(self.frame, text=name, font=("Microsoft YaHei UI", 9, "bold"),
                         bg=c["bg"], fg=c["fg"], anchor="w")
        title.grid(row=base, column=0, columnspan=3, sticky="w", pady=(6 if index else 0, 2))
        rows = {"title": title}
        for i, (key, label) in enumerate(WINDOW_LABELS):
            r = base + 1 + i
            tk.Label(self.frame, text=label, width=3, font=("Microsoft YaHei UI", 8),
                     bg=c["bg"], fg=c["sub"], anchor="w").grid(row=r, column=0, sticky="w")
            canvas = tk.Canvas(self.frame, width=BAR_W, height=BAR_H, bg=c["bg"],
                               highlightthickness=0, bd=0)
            canvas.grid(row=r, column=1, padx=(2, 8))
            text = tk.Label(self.frame, text="--", width=22, font=("Consolas", 9),
                            bg=c["bg"], fg=c["fg"], anchor="w")
            text.grid(row=r, column=2, sticky="w")
            rows[key] = (canvas, text)
        self.rows[name] = rows

    def _build_menu(self) -> None:
        self.topmost_var = tk.BooleanVar(value=bool(self.cfg["topmost"]))
        self.autostart_var = tk.BooleanVar(value=os.path.exists(startup_script_path()))
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="立即刷新", command=lambda: self.refresh(force=True))
        menu.add_checkbutton(label="窗口置顶", variable=self.topmost_var, command=self._toggle_topmost)
        if sys.platform == "win32":
            menu.add_checkbutton(label="开机自启", variable=self.autostart_var,
                                 command=self._toggle_autostart)
        alpha_menu = tk.Menu(menu, tearoff=0)
        for a in (0.5, 0.65, 0.82, 1.0):
            alpha_menu.add_command(label=f"{int(a * 100)}%", command=lambda v=a: self._set_alpha(v))
        menu.add_cascade(label="不透明度", menu=alpha_menu)
        menu.add_separator()
        menu.add_command(label="退出", command=self.quit)
        self.menu = menu

    def _bind_drag(self, widget: tk.Misc) -> None:
        widget.bind("<ButtonPress-1>", self._start_drag)
        widget.bind("<B1-Motion>", self._on_drag)
        widget.bind("<ButtonRelease-1>", self._end_drag)
        widget.bind("<Double-Button-1>", lambda e: self.refresh(force=True))
        widget.bind("<Button-3>", lambda e: self.menu.tk_popup(e.x_root, e.y_root))
        for child in widget.winfo_children():
            self._bind_drag(child)

    def _place_window(self) -> None:
        self.root.update_idletasks()
        w = self.root.winfo_reqwidth()
        x = self.cfg["x"]
        if x is None:
            x = self.root.winfo_screenwidth() - w - 24
        self.root.geometry(f"+{int(x)}+{int(self.cfg['y'])}")

    # ---------------------------------------------------------- 交互
    def _start_drag(self, event) -> None:
        self._drag = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def _on_drag(self, event) -> None:
        dx, dy = self._drag
        self.root.geometry(f"+{event.x_root - dx}+{event.y_root - dy}")

    def _end_drag(self, _event) -> None:
        self.cfg["x"], self.cfg["y"] = self.root.winfo_x(), self.root.winfo_y()
        save_config(self.cfg)

    def _toggle_topmost(self) -> None:
        self.cfg["topmost"] = self.topmost_var.get()
        self.root.attributes("-topmost", self.cfg["topmost"])
        save_config(self.cfg)

    def _set_alpha(self, value: float) -> None:
        self.cfg["alpha"] = value
        self.root.attributes("-alpha", value)
        save_config(self.cfg)

    def _toggle_autostart(self) -> None:
        path = startup_script_path()
        if self.autostart_var.get():
            pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
            script = os.path.abspath(__file__)
            with open(path, "w", encoding="utf-16") as f:
                f.write(f'CreateObject("WScript.Shell").Run """{pythonw}"" ""{script}""", 0, False\r\n')
        elif os.path.exists(path):
            os.remove(path)

    def quit(self) -> None:
        save_config(self.cfg)
        self.root.destroy()

    # ---------------------------------------------------------- 数据
    def refresh(self, force: bool = False) -> None:
        if self.fetching:
            return
        self.fetching = True
        self.status.configure(text="正在刷新…")
        threading.Thread(target=self._fetch_all, args=(force,), daemon=True).start()

    def _fetch_all(self, force: bool = False) -> None:
        results = {}
        for provider_cls in PROVIDERS:
            try:
                results[provider_cls.name] = provider_cls().fetch(force=force)
            except Exception as exc:  # noqa: BLE001 - 不让单个数据源拖垮界面
                results[provider_cls.name] = ProviderResult(provider_cls.name, error=str(exc))
        self.root.after(0, self._apply, results)

    def _apply(self, results: dict) -> None:
        self.fetching = False
        for name, res in results.items():
            old = self.results.get(name)
            # 本次失败时保留上一次的有效数据，避免数字闪成 --
            if res.error and old and old.windows:
                old.error = res.error
                continue
            self.results[name] = res
        self._status_text = f"更新于 {time.strftime('%H:%M')} · 双击刷新 · 右键菜单"
        self.status.configure(text=self._status_text)
        self._render()

    def _render(self) -> None:
        c = self.colors
        now = time.time()
        for name, rows in self.rows.items():
            res = self.results.get(name)
            suffix = f" · {res.source}" if res and res.source else ""
            rows["title"].configure(text=name + suffix)
            for key, _ in WINDOW_LABELS:
                canvas, text = rows[key]
                canvas.delete("all")
                canvas.create_rectangle(0, 0, BAR_W, BAR_H, fill=c["track"], width=0)
                win = res.windows.get(key) if res else None
                if win is None:
                    text.configure(text="未连接" if res and res.error else "--", fg=c["sub"])
                    continue
                color = c["ok"] if win.remaining >= 50 else c["warn"] if win.remaining >= 20 else c["bad"]
                canvas.create_rectangle(0, 0, BAR_W * win.remaining / 100, BAR_H, fill=color, width=0)
                reset = fmt_duration(win.reset_in(now))
                text.configure(text=f"{win.remaining:5.1f}%" + (f"  {reset}后重置" if reset else ""),
                               fg=c["fg"])
            if res and res.error:
                rows["title"].configure(text=f"{name} · ⚠")
                self._tooltip(rows["title"], res.error)
            else:
                self._clear_tooltip(rows["title"])

    def _tooltip(self, widget: tk.Widget, message: str) -> None:
        widget.bind("<Enter>", lambda _e, msg=message: self.status.configure(text=msg[:60]))
        widget.bind("<Leave>", lambda _e: self.status.configure(text=self._status_text))

    def _clear_tooltip(self, widget: tk.Widget) -> None:
        widget.unbind("<Enter>")
        widget.unbind("<Leave>")

    def _tick(self) -> None:
        """每 30 秒刷新倒计时，按配置间隔重新拉取数据。"""
        self._render()
        self._elapsed = getattr(self, "_elapsed", 0) + 30
        if self._elapsed >= int(self.cfg["refresh_seconds"]):
            self._elapsed = 0
            self.refresh()
        self.root.after(30_000, self._tick)

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    QuotaFloat().run()
