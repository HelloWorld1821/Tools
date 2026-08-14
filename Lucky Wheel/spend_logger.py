from decimal import Decimal, InvalidOperation
import tkinter as tk

from lucky_draw import (
    ACCENT,
    MUTED,
    PANEL_BG,
    PRIZE_FILE,
    PRIMARY,
    TEXT,
    WINDOW_BG,
    format_money,
    write_expense,
)


def parse_expense_amount(text):
    value = text.strip()

    if not value:
        raise ValueError("请输入花销金额")

    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("请输入有效数字") from exc

    if amount <= 0:
        raise ValueError("花销金额必须大于 0")

    return amount


class SpendLoggerApp:
    def __init__(self, root):
        self.root = root
        self.amount_var = tk.StringVar()

        self.root.title("花销记录")
        self.root.geometry("420x320")
        self.root.resizable(False, False)
        self.root.configure(bg=WINDOW_BG)

        self._build_ui()

    def _build_ui(self):
        tk.Label(
            self.root,
            text="记录花销",
            font=("微软雅黑", 24, "bold"),
            fg=TEXT,
            bg=WINDOW_BG,
        ).pack(anchor="w", padx=28, pady=(26, 4))

        tk.Label(
            self.root,
            text=f"提交后会同步更新 {PRIZE_FILE.name}",
            font=("微软雅黑", 11),
            fg=MUTED,
            bg=WINDOW_BG,
        ).pack(anchor="w", padx=28, pady=(0, 18))

        panel = tk.Frame(self.root, bg=PANEL_BG, highlightthickness=1, highlightbackground="#e5e7eb")
        panel.pack(fill="x", padx=28, pady=(0, 18))

        tk.Label(
            panel,
            text="花销金额",
            font=("微软雅黑", 12, "bold"),
            fg=TEXT,
            bg=PANEL_BG,
        ).pack(anchor="w", padx=20, pady=(18, 8))

        entry = tk.Entry(
            panel,
            textvariable=self.amount_var,
            font=("Consolas", 20, "bold"),
            fg=TEXT,
            bg="#f9fafb",
            insertbackground=TEXT,
            bd=0,
            highlightthickness=1,
            highlightbackground="#d1d5db",
            highlightcolor=ACCENT,
        )
        entry.pack(fill="x", padx=20, ipady=8)
        entry.focus_set()
        entry.bind("<Return>", lambda _event: self.submit())

        tk.Button(
            panel,
            text="提交花销",
            font=("微软雅黑", 13, "bold"),
            fg="#ffffff",
            bg=PRIMARY,
            activeforeground="#ffffff",
            activebackground="#c92a2f",
            bd=0,
            cursor="hand2",
            padx=18,
            pady=10,
            command=self.submit,
        ).pack(fill="x", padx=20, pady=(16, 20))

        self.status_label = tk.Label(
            self.root,
            text="等待输入",
            font=("微软雅黑", 11),
            fg=MUTED,
            bg=WINDOW_BG,
        )
        self.status_label.pack()

        self.summary_label = tk.Label(
            self.root,
            text="",
            font=("微软雅黑", 12, "bold"),
            fg=TEXT,
            bg=WINDOW_BG,
        )
        self.summary_label.pack(pady=(8, 0))

    def submit(self):
        try:
            amount = parse_expense_amount(self.amount_var.get())
            expense, _prize_total, expense_total, balance = write_expense(amount)
        except ValueError as exc:
            self.status_label.config(text=str(exc), fg=PRIMARY)
            return
        except Exception as exc:
            self.status_label.config(text=f"同步失败：{exc}", fg=PRIMARY)
            return

        self.amount_var.set("")
        self.status_label.config(text=f"已同步到 {PRIZE_FILE.name}", fg=ACCENT)
        self.summary_label.config(
            text=f"本次花销 {format_money(expense)} 元  |  累计花销 {format_money(expense_total)} 元  |  剩余 {format_money(balance)} 元"
        )


def main():
    root = tk.Tk()
    SpendLoggerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
