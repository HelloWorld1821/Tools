import time
import unittest

from providers import (classify, latest_rate_limits_from_lines, parse_antigravity_status,
                       parse_cmdline_args, parse_codex_usage, parse_netstat_ports, parse_time)


class ParseTimeTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(parse_time(1700000000), 1700000000)
        self.assertEqual(parse_time(1700000000000), 1700000000)
        self.assertEqual(parse_time("2023-11-14T22:13:20Z"), 1700000000)
        self.assertEqual(parse_time("2023-11-14T22:13:20.123456789Z"), 1700000000.123456)
        self.assertIsNone(parse_time("not a time"))

    def test_classify(self):
        self.assertEqual(classify(18000, None), "5h")
        self.assertEqual(classify(604800, None), "week")
        self.assertEqual(classify(None, 3600), "5h")
        self.assertEqual(classify(None, 3 * 86400), "week")


class CodexTest(unittest.TestCase):
    def test_usage_api(self):
        now = time.time()
        data = {"rate_limit": {
            "primary_window": {"used_percent": 12, "limit_window_seconds": 18000,
                               "reset_at": now + 100},
            "secondary_window": {"used_percent": 30, "limit_window_seconds": 604800,
                                 "reset_after_seconds": 5000}}}
        w = parse_codex_usage(data)
        self.assertEqual(w["5h"].remaining, 88)
        self.assertEqual(w["week"].remaining, 70)
        self.assertAlmostEqual(w["week"].reset_at, now + 5000, delta=2)

    def test_session_log_latest_event(self):
        future = int(time.time()) + 3600
        lines = [
            '{"type":"event_msg","payload":{"type":"token_count","rate_limits":'
            '{"primary":{"used_percent":5,"window_minutes":300,"resets_at":%d}}}}' % future,
            '{"type":"other"}',
            '{"timestamp":"2099-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count",'
            '"rate_limits":{"primary":{"used_percent":40,"window_minutes":300,"resets_at":%d},'
            '"secondary":{"used_percent":10,"window_minutes":10080,"resets_at":%d}}}}'
            % (future, future + 86400),
        ]
        w = latest_rate_limits_from_lines(lines)
        self.assertEqual(w["5h"].remaining, 60)
        self.assertEqual(w["week"].remaining, 90)

    def test_expired_window_is_restored(self):
        line = ('{"payload":{"rate_limits":{"primary":{"used_percent":99,"window_minutes":300,'
                '"resets_at":1000}}}}')
        w = latest_rate_limits_from_lines([line])
        self.assertEqual(w["5h"].remaining, 100)
        self.assertIsNone(w["5h"].reset_at)


class AntigravityTest(unittest.TestCase):
    def test_status_takes_tightest_pool_per_window(self):
        now = 1_700_000_000
        iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
        data = {"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": "Gemini", "quotaInfo": {"remainingFraction": 0.8, "resetTime": iso(now + 3600)}},
            {"label": "Claude", "quotaInfo": {"remainingFraction": 0.35, "resetTime": iso(now + 7200)}},
            {"label": "Weekly", "quotaInfo": {"remainingFraction": 0.6, "resetTime": iso(now + 4 * 86400)}},
        ]}}}
        w = parse_antigravity_status(data, now=now)
        self.assertAlmostEqual(w["5h"].remaining, 35)
        self.assertAlmostEqual(w["week"].remaining, 60)

    def test_explicit_week_key(self):
        data = {"weeklyQuota": {"remainingFraction": 0.25, "resetTime": "2099-01-01T00:00:00Z"},
                "fiveHourQuota": {"remainingFraction": 0.5}}
        w = parse_antigravity_status(data)
        self.assertEqual(w["week"].remaining, 25)
        self.assertEqual(w["5h"].remaining, 50)

    def test_cmdline_and_netstat(self):
        args = parse_cmdline_args('language_server_windows_x64.exe --csrf_token abc-123 '
                                  '--extension_server_port 51000 --other x')
        self.assertEqual(args, {"csrf_token": "abc-123", "extension_server_port": "51000"})
        out = ("  TCP    127.0.0.1:51001   0.0.0.0:0   LISTENING   42\n"
               "  TCP    127.0.0.1:51002   0.0.0.0:0   LISTENING   7\n"
               "  TCP    127.0.0.1:51003   127.0.0.1:1 ESTABLISHED 42\n")
        self.assertEqual(parse_netstat_ports(out, 42), [51001])


if __name__ == "__main__":
    unittest.main()
