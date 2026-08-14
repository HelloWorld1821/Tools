import importlib
import sys
import tempfile
import types
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path


class _FakeWidget:
    def __init__(self, *args, **kwargs):
        pass

    def pack(self, *args, **kwargs):
        pass

    def config(self, *args, **kwargs):
        pass


class _FakeTk(_FakeWidget):
    def title(self, *args, **kwargs):
        pass

    def geometry(self, *args, **kwargs):
        pass

    def resizable(self, *args, **kwargs):
        pass

    def mainloop(self):
        pass


class _FakeCanvas(_FakeWidget):
    def create_image(self, *args, **kwargs):
        return 1

    def create_text(self, *args, **kwargs):
        return 1

    def itemconfig(self, *args, **kwargs):
        pass


class _FakeImage:
    size = (50, 50)

    def resize(self, *args, **kwargs):
        return self

    def rotate(self, *args, **kwargs):
        return self

    def paste(self, *args, **kwargs):
        pass


def _install_fake_gui_modules():
    fake_tk = types.SimpleNamespace(Tk=_FakeTk, Canvas=_FakeCanvas, Label=_FakeWidget, Button=_FakeWidget)
    fake_image = types.SimpleNamespace(
        open=lambda *args, **kwargs: _FakeImage(),
        new=lambda *args, **kwargs: _FakeImage(),
        BICUBIC=1,
    )
    fake_image_tk = types.SimpleNamespace(PhotoImage=lambda *args, **kwargs: object())
    fake_pil = types.SimpleNamespace(Image=fake_image, ImageTk=fake_image_tk)

    sys.modules["tkinter"] = fake_tk
    sys.modules["PIL"] = fake_pil
    sys.modules["PIL.Image"] = fake_image
    sys.modules["PIL.ImageTk"] = fake_image_tk


def _load_lucky_draw():
    _install_fake_gui_modules()
    sys.modules.pop("lucky_draw", None)
    return importlib.import_module("lucky_draw")


def _load_spend_logger():
    _install_fake_gui_modules()
    sys.modules.pop("spend_logger", None)
    return importlib.import_module("spend_logger")


class PrizeRecordTests(unittest.TestCase):
    def test_write_prize_session_adds_timestamp_session_total_and_updates_grand_total(self):
        lucky_draw = _load_lucky_draw()

        with tempfile.TemporaryDirectory() as temp_dir:
            record_path = Path(temp_dir) / "prize.txt"

            lucky_draw.write_prize_session(
                [1.23, 2.34],
                record_path=record_path,
                now=datetime(2026, 8, 10, 12, 1, 2),
            )
            lucky_draw.write_prize_session(
                [0.43],
                record_path=record_path,
                now=datetime(2026, 8, 10, 12, 5, 6),
            )

            lines = record_path.read_text(encoding="utf-8").splitlines()

        self.assertIn("[2026-08-10 12:01:02] 抽奖2次", lines)
        self.assertIn("奖品金额: 1.23, 2.34", lines)
        self.assertIn("本次抽奖总金额: 3.57", lines)
        self.assertIn("[2026-08-10 12:05:06] 抽奖1次", lines)
        self.assertIn("奖品金额: 0.43", lines)
        self.assertIn("本次抽奖总金额: 0.43", lines)
        self.assertIn("所有抽奖总金额: 4.00", lines[-3:])
        self.assertIn("所有花销总金额: 0.00", lines[-3:])
        self.assertEqual(lines[-1], "当前剩余金额: 4.00")
        self.assertEqual(lines.count("所有抽奖总金额: 4.00"), 1)

    def test_write_expense_adds_timestamp_expense_and_updates_balance(self):
        lucky_draw = _load_lucky_draw()

        with tempfile.TemporaryDirectory() as temp_dir:
            record_path = Path(temp_dir) / "prize.txt"

            lucky_draw.write_prize_session(
                [3.00, 2.00],
                record_path=record_path,
                now=datetime(2026, 8, 10, 12, 1, 2),
            )
            lucky_draw.write_expense(
                1.25,
                record_path=record_path,
                now=datetime(2026, 8, 10, 12, 6, 7),
            )

            lines = record_path.read_text(encoding="utf-8").splitlines()

        self.assertIn("[2026-08-10 12:06:07] 花销记录", lines)
        self.assertIn("花销金额: 1.25", lines)
        self.assertIn("所有抽奖总金额: 5.00", lines[-3:])
        self.assertIn("所有花销总金额: 1.25", lines[-3:])
        self.assertEqual(lines[-1], "当前剩余金额: 3.75")


class ProbabilityTests(unittest.TestCase):
    def test_probability_distribution_targets_half_yuan_expected_value(self):
        lucky_draw = _load_lucky_draw()

        expected_value = sum(value * prob for value, prob in zip(lucky_draw.values, lucky_draw.probs))
        under_one_probability = sum(
            prob for value, prob in zip(lucky_draw.values, lucky_draw.probs) if value < 1
        )

        self.assertAlmostEqual(sum(lucky_draw.probs), 1.0, places=12)
        self.assertGreater(under_one_probability, 0.90)
        self.assertGreaterEqual(expected_value, 0.49)
        self.assertLessEqual(expected_value, 0.51)


class PrizeTierTests(unittest.TestCase):
    def test_prize_tiers_follow_configured_boundaries(self):
        lucky_draw = _load_lucky_draw()

        cases = [
            (0.01, "blue"),
            (1.00, "blue"),
            (1.01, "purple"),
            (2.50, "purple"),
            (2.51, "gold"),
            (5.00, "gold"),
            (5.01, "red"),
            (10.00, "red"),
        ]

        for amount, expected_key in cases:
            with self.subTest(amount=amount):
                self.assertEqual(lucky_draw.get_prize_tier(amount)["key"], expected_key)


class SpendLoggerTests(unittest.TestCase):
    def test_parse_expense_amount_accepts_positive_number(self):
        spend_logger = _load_spend_logger()

        self.assertEqual(spend_logger.parse_expense_amount(" 12.34 "), Decimal("12.34"))

    def test_parse_expense_amount_rejects_invalid_values(self):
        spend_logger = _load_spend_logger()

        for value in ["", "abc", "0", "-1"]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    spend_logger.parse_expense_amount(value)

    def test_parsed_expense_amount_can_be_written_to_record(self):
        spend_logger = _load_spend_logger()
        lucky_draw = _load_lucky_draw()

        with tempfile.TemporaryDirectory() as temp_dir:
            record_path = Path(temp_dir) / "prize.txt"

            lucky_draw.write_expense(
                spend_logger.parse_expense_amount("12.34"),
                record_path=record_path,
                now=datetime(2026, 8, 10, 12, 6, 7),
            )

            lines = record_path.read_text(encoding="utf-8").splitlines()

        self.assertIn("花销金额: 12.34", lines)


if __name__ == "__main__":
    unittest.main()
