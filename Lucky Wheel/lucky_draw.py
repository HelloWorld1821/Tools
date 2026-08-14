import math
import random
import threading
import time
from datetime import datetime
from decimal import Decimal
from pathlib import Path
import tkinter as tk

from PIL import Image, ImageTk


# ======================
# 概率参数（保持不变）
# ======================
MIN_MONEY = 0.01
MAX_MONEY = 10.00
STEP = 0.01
TOP_PROB = 0.01
LAMBDA = 2.5

values = [round(i * STEP, 2) for i in range(1, int(MAX_MONEY / STEP) + 1)]
raw_probs = [0 if v == MAX_MONEY else math.exp(-LAMBDA * v) for v in values]
sum_raw = sum(raw_probs)
probs = [(p / sum_raw) * (1 - TOP_PROB) for p in raw_probs]
probs[-1] = TOP_PROB


def draw():
    return random.choices(values, weights=probs, k=1)[0]


# ======================
# 抽奖记录
# ======================
BASE_DIR = Path(__file__).resolve().parent
PRIZE_FILE = BASE_DIR / "prize.txt"
SESSION_TOTAL_PREFIX = "本次抽奖总金额: "
GRAND_TOTAL_PREFIX = "所有抽奖总金额: "
EXPENSE_TOTAL_PREFIX = "花销金额: "
GRAND_EXPENSE_PREFIX = "所有花销总金额: "
BALANCE_PREFIX = "当前剩余金额: "
SUMMARY_PREFIXES = (GRAND_TOTAL_PREFIX, GRAND_EXPENSE_PREFIX, BALANCE_PREFIX)


def money_to_decimal(amount):
    return Decimal(f"{amount:.2f}")


def format_money(amount):
    return f"{amount:.2f}"


def calculate_recorded_grand_total(lines):
    total = Decimal("0.00")

    for line in lines:
        stripped = line.strip()
        if stripped.startswith(SESSION_TOTAL_PREFIX):
            total += Decimal(stripped.removeprefix(SESSION_TOTAL_PREFIX))
        elif _is_legacy_prize_line(stripped):
            total += Decimal(stripped)

    return total


def calculate_recorded_expense_total(lines):
    total = Decimal("0.00")

    for line in lines:
        stripped = line.strip()
        if stripped.startswith(EXPENSE_TOTAL_PREFIX):
            total += Decimal(stripped.removeprefix(EXPENSE_TOTAL_PREFIX))

    return total


def strip_summary_lines(lines):
    kept_lines = [line for line in lines if not line.startswith(SUMMARY_PREFIXES)]

    while kept_lines and kept_lines[-1] == "":
        kept_lines.pop()

    return kept_lines


def build_summary_lines(lines):
    prize_total = calculate_recorded_grand_total(lines)
    expense_total = calculate_recorded_expense_total(lines)
    balance = prize_total - expense_total

    return (
        [
            f"{GRAND_TOTAL_PREFIX}{format_money(prize_total)}",
            f"{GRAND_EXPENSE_PREFIX}{format_money(expense_total)}",
            f"{BALANCE_PREFIX}{format_money(balance)}",
        ],
        prize_total,
        expense_total,
        balance,
    )


def write_record_block(record_path, block_lines):
    record_path = Path(record_path)

    if record_path.exists():
        lines = record_path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []

    kept_lines = strip_summary_lines(lines)

    if kept_lines:
        kept_lines.append("")

    kept_lines.extend(block_lines)
    summary_lines, prize_total, expense_total, balance = build_summary_lines(kept_lines)
    kept_lines.extend(["", *summary_lines])

    record_path.write_text("\n".join(kept_lines) + "\n", encoding="utf-8")
    return prize_total, expense_total, balance


def _is_legacy_prize_line(line):
    try:
        Decimal(line)
    except Exception:
        return False
    return bool(line)


def write_prize_session(prizes, record_path=PRIZE_FILE, now=None):
    now = now or datetime.now()
    prizes = list(prizes)
    session_total = sum((money_to_decimal(prize) for prize in prizes), Decimal("0.00"))
    timestamp = now.strftime("%Y-%m-%d %H:%M:%S")
    prize_text = ", ".join(format_money(prize) for prize in prizes)

    block_lines = [
        f"[{timestamp}] 抽奖{len(prizes)}次",
        f"奖品金额: {prize_text}",
        f"{SESSION_TOTAL_PREFIX}{format_money(session_total)}",
    ]
    grand_total, _, _ = write_record_block(record_path, block_lines)
    return session_total, grand_total


def write_expense(amount, record_path=PRIZE_FILE, now=None):
    now = now or datetime.now()
    expense = money_to_decimal(amount)

    if expense <= 0:
        raise ValueError("花销金额必须大于 0")

    timestamp = now.strftime("%Y-%m-%d %H:%M:%S")
    block_lines = [
        f"[{timestamp}] 花销记录",
        f"{EXPENSE_TOTAL_PREFIX}{format_money(expense)}",
    ]
    prize_total, expense_total, balance = write_record_block(record_path, block_lines)
    return expense, prize_total, expense_total, balance


# ======================
# GUI
# ======================
SIZE = 380
CENTER = SIZE // 2
WINDOW_BG = "#f5f7fb"
PANEL_BG = "#ffffff"
PRIMARY = "#e5484d"
PRIMARY_DARK = "#c92a2f"
ACCENT = "#2563eb"
TEXT = "#1f2937"
MUTED = "#6b7280"
BLUE = "#2563eb"
PURPLE = "#7c3aed"
GOLD = "#d97706"
GOLD_LIGHT = "#fbbf24"
RED = "#dc2626"
RED_LIGHT = "#f97316"

PRIZE_TIERS = [
    {"key": "blue", "max": 1.00, "color": BLUE, "label": "蓝色奖励", "message": "稳稳入袋"},
    {"key": "purple", "max": 2.50, "color": PURPLE, "label": "紫色奖励", "message": "手气升温"},
    {"key": "gold", "max": 5.00, "color": GOLD, "label": "金色奖励", "message": "漂亮，这一发很有感觉！"},
    {"key": "red", "max": 10.00, "color": RED, "label": "红色大奖", "message": "大奖来了，这波起飞！"},
]


def get_prize_tier(amount):
    for tier in PRIZE_TIERS:
        if amount <= tier["max"]:
            return tier
    return PRIZE_TIERS[-1]


class LuckyDrawApp:
    def __init__(self, root):
        self.root = root
        self.is_spinning = False
        self.history = []
        self.effect_token = 0

        self.root.title("抽奖转盘")
        self.root.geometry("520x760")
        self.root.resizable(False, False)
        self.root.configure(bg=WINDOW_BG)

        self._build_ui()
        self._load_images()
        self._draw_wheel_marks()

    def _build_ui(self):
        header = tk.Frame(self.root, bg=WINDOW_BG)
        header.pack(fill="x", padx=28, pady=(22, 10))

        tk.Label(
            header,
            text="幸运抽奖转盘",
            font=("微软雅黑", 24, "bold"),
            fg=TEXT,
            bg=WINDOW_BG,
        ).pack(anchor="w")

        tk.Label(
            header,
            text="单抽试试手气，十连抽一次看够",
            font=("微软雅黑", 11),
            fg=MUTED,
            bg=WINDOW_BG,
        ).pack(anchor="w", pady=(4, 0))

        wheel_panel = tk.Frame(self.root, bg=PANEL_BG, bd=0, highlightthickness=1, highlightbackground="#e5e7eb")
        wheel_panel.pack(padx=28, pady=(4, 14))

        self.canvas = tk.Canvas(
            wheel_panel,
            width=SIZE,
            height=SIZE,
            bg=PANEL_BG,
            highlightthickness=0,
        )
        self.canvas.pack(padx=22, pady=22)

        self.result_label = tk.Label(
            self.root,
            text="0.00 元",
            font=("Consolas", 34, "bold"),
            fg=PRIMARY,
            bg=WINDOW_BG,
        )
        self.result_label.pack()

        self.tier_label = tk.Label(
            self.root,
            text="等待开奖",
            font=("微软雅黑", 13, "bold"),
            fg=MUTED,
            bg=WINDOW_BG,
        )
        self.tier_label.pack(pady=(0, 2))

        self.status_label = tk.Label(
            self.root,
            text="准备开始",
            font=("微软雅黑", 11),
            fg=MUTED,
            bg=WINDOW_BG,
        )
        self.status_label.pack(pady=(2, 12))

        button_row = tk.Frame(self.root, bg=WINDOW_BG)
        button_row.pack(pady=(0, 18))

        self.single_btn = tk.Button(
            button_row,
            text="开始抽奖",
            font=("微软雅黑", 14, "bold"),
            width=12,
            padx=12,
            pady=14,
            fg="#ffffff",
            bg=PRIMARY,
            activeforeground="#ffffff",
            activebackground=PRIMARY_DARK,
            bd=0,
            cursor="hand2",
            command=lambda: self.start_draws(1),
        )
        self.single_btn.pack(side="left", padx=8)

        self.ten_btn = tk.Button(
            button_row,
            text="连抽十次",
            font=("微软雅黑", 14, "bold"),
            width=12,
            padx=12,
            pady=14,
            fg="#ffffff",
            bg=ACCENT,
            activeforeground="#ffffff",
            activebackground="#1d4ed8",
            bd=0,
            cursor="hand2",
            command=lambda: self.start_draws(10),
        )
        self.ten_btn.pack(side="left", padx=8)

        self.total_label = tk.Label(
            self.root,
            text="本次合计：0.00 元",
            font=("微软雅黑", 12, "bold"),
            fg=TEXT,
            bg=WINDOW_BG,
        )
        self.total_label.pack()

    def _load_images(self):
        wheel_img = Image.open(BASE_DIR / "wheel.png").resize((SIZE, SIZE))
        self.wheel_tk = ImageTk.PhotoImage(wheel_img)
        self.canvas.create_image(CENTER, CENTER, image=self.wheel_tk)

        pointer_img = Image.open(BASE_DIR / "pointer.png").resize((50, 50))
        width, height = pointer_img.size
        self.pointer_canvas_size = max(width, height) * 2
        self.pointer_canvas = Image.new("RGBA", (self.pointer_canvas_size, self.pointer_canvas_size), (0, 0, 0, 0))
        self.pointer_canvas.paste(pointer_img, (self.pointer_canvas_size // 2, self.pointer_canvas_size // 2 - height))
        self.pointer_tk = ImageTk.PhotoImage(self.pointer_canvas)
        self.pointer_item = self.canvas.create_image(CENTER, CENTER, image=self.pointer_tk)

    def _draw_wheel_marks(self):
        numbers = [10] + list(range(1, 10))
        for index, num in enumerate(numbers):
            angle = math.radians(index * 36 - 90)
            radius = SIZE // 2 - 18
            x = CENTER + radius * math.cos(angle)
            y = CENTER + radius * math.sin(angle)
            self.canvas.create_text(x, y, text=str(num), font=("Consolas", 20, "bold"), fill=TEXT)

    def rotate_pointer(self, angle):
        rotated = self.pointer_canvas.rotate(
            -angle,
            resample=Image.BICUBIC,
            center=(self.pointer_canvas_size // 2, self.pointer_canvas_size // 2),
            expand=True,
        )
        tk_img = ImageTk.PhotoImage(rotated)
        self.canvas.itemconfig(self.pointer_item, image=tk_img)
        self.canvas.image = tk_img

    def start_draws(self, count):
        if self.is_spinning:
            return

        self.is_spinning = True
        self.history = []
        self._set_buttons_state(tk.DISABLED)
        self.total_label.config(text="本次合计：0.00 元")
        threading.Thread(target=self._spin_sequence, args=(count,), daemon=True).start()

    def _spin_sequence(self, count):
        self.history = [draw() for _ in range(count)]

        try:
            session_total, grand_total = write_prize_session(self.history)
        except Exception as exc:
            self.root.after(0, self._show_record_error, exc)
            return

        for index, prize in enumerate(self.history):
            self._spin_once(prize, index + 1, count)
            time.sleep(0.25)

        self.root.after(0, self._finish_sequence, session_total, grand_total)

    def _spin_once(self, prize, current, total):
        num = min(prize, 10)
        target_angle = num * 36 - 45
        duration = 2.4 if total > 1 else 4.0
        fps = 60
        frames = int(duration * fps)
        total_rounds = random.randint(4, 6)
        start_angle = 0
        end_angle = total_rounds * 360 + target_angle

        self.root.after(0, self.status_label.config, {"text": f"第 {current}/{total} 次抽奖中..."})

        for frame in range(frames):
            t = frame / (frames - 1)
            progress = 1 - (1 - t) ** 2
            angle = start_angle + (end_angle - start_angle) * progress
            self.root.after(0, self.rotate_pointer, angle % 360)
            time.sleep(1 / fps)

        self.root.after(0, self.rotate_pointer, target_angle)
        self.root.after(0, self._show_prize_result, prize)

    def _show_prize_result(self, prize):
        tier = get_prize_tier(prize)
        self.effect_token += 1
        token = self.effect_token

        self.result_label.config(text=f"{prize:.2f} 元", fg=tier["color"])
        self.tier_label.config(text=f'{tier["label"]} · {tier["message"]}', fg=tier["color"])

        if tier["key"] == "gold":
            self._flash_prize(token, [GOLD, GOLD_LIGHT], 8, 130)
        elif tier["key"] == "red":
            self.root.bell()
            self._flash_prize(token, [RED, RED_LIGHT, "#be123c"], 12, 110)

    def _flash_prize(self, token, colors, remaining, delay_ms):
        if token != self.effect_token or remaining <= 0:
            return

        color = colors[remaining % len(colors)]
        self.result_label.config(fg=color)
        self.tier_label.config(fg=color)
        self.root.after(delay_ms, self._flash_prize, token, colors, remaining - 1, delay_ms)

    def _finish_sequence(self, session_total, grand_total):
        self.is_spinning = False
        self._set_buttons_state(tk.NORMAL)
        self.total_label.config(text=f"本次合计：{format_money(session_total)} 元")
        self.status_label.config(text=f"已写入 prize.txt，累计：{format_money(grand_total)} 元")

    def _show_record_error(self, error):
        self.is_spinning = False
        self._set_buttons_state(tk.NORMAL)
        self.status_label.config(text=f"写入 prize.txt 失败：{error}")

    def _set_buttons_state(self, state):
        self.single_btn.config(state=state)
        self.ten_btn.config(state=state)


def main():
    root = tk.Tk()
    LuckyDrawApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
