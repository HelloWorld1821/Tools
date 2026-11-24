import json
import os
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from providers import (
    AntigravityProvider,
    classify,
    is_standalone_cmdline,
    latest_rate_limits_from_lines,
    parse_antigravity_quota_summary,
    parse_antigravity_status,
    parse_cmdline_args,
    parse_codex_usage,
    parse_fraction,
    parse_http_log_ports,
    parse_net_tcp_connections,
    parse_netstat_ports,
    parse_netstat_snapshot,
    parse_time,
    read_log_http_ports,
    resolve_daemon_credential,
)


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


class AntigravitySummaryTest(unittest.TestCase):
    def test_paid_pro_groups_pick_shared_gemini_only(self):
        reset = "2026-11-07T06:50:31Z"
        data = {"response": {"groups": [
            {"displayName": "Claude and GPT models", "buckets": [
                {"bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.1, "resetTime": reset},
                {"bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 0.2, "resetTime": reset},
            ]},
            {"displayName": "Gemini 4 Argon", "buckets": [
                {"bucketId": "gemini-argon-wtu-weekly", "window": "weekly",
                 "remainingFraction": 0.42, "resetTime": reset},
            ]},
            {"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.8, "resetTime": reset},
                {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.7, "resetTime": reset},
            ]},
        ]}}
        w = parse_antigravity_quota_summary(data)
        self.assertAlmostEqual(w["5h"].remaining, 80.0)
        self.assertAlmostEqual(w["week"].remaining, 70.0)
        self.assertEqual(w["5h"].reset_at, parse_time(reset))

    def test_flat_buckets_both_orders_keep_families_separate(self):
        gemini = [
            {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.85},
            {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.65},
        ]
        argon = {"bucketId": "gemini-argon-wtu-weekly", "displayName": "Gemini 4 Argon",
                 "window": "weekly", "remainingFraction": 0.17}
        third = {"bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.05}
        for buckets in ([*gemini, argon, third], [third, argon, *gemini]):
            w = parse_antigravity_quota_summary({"buckets": buckets})
            self.assertAlmostEqual(w["5h"].remaining, 85.0)
            self.assertAlmostEqual(w["week"].remaining, 65.0)

    def test_opaque_group_id_and_argon_only_fallback(self):
        opaque = {"groups": [
            {"displayName": "Claude", "buckets": [{"window": "5h", "remainingFraction": 0.2}]},
            {"displayName": "Gemini", "buckets": [
                {"window": "5h", "remainingFraction": 0.9},
                {"window": "weekly", "remainingFraction": 0.75},
            ]},
        ]}
        w = parse_antigravity_quota_summary(opaque)
        self.assertAlmostEqual(w["5h"].remaining, 90.0)
        self.assertAlmostEqual(w["week"].remaining, 75.0)

        argon_only = {"groups": [{"displayName": "Gemini 4 Argon", "buckets": [
            {"bucketId": "gemini-argon-wtu-weekly", "window": "weekly", "remainingFraction": 0.42},
        ]}]}
        w2 = parse_antigravity_quota_summary(argon_only)
        self.assertNotIn("5h", w2)
        self.assertAlmostEqual(w2["week"].remaining, 42.0)

    def test_strict_fraction_disabled_window_and_reset_time(self):
        for val in (True, False, None, "", " ", [], {}, -0.1, 1.01, "0x1", "bad", float("nan")):
            self.assertIsNone(parse_fraction(val))
        self.assertEqual(parse_fraction(0), 0.0)
        self.assertEqual(parse_fraction("0"), 0.0)

        data = {"groups": [{"displayName": "Gemini Models", "buckets": [
            {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0, "resetTime": 0},
            {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": None,
             "remaining": {"remainingFraction": 0.5}},
            {"bucketId": "gemini-weekly", "window": "monthly", "remainingFraction": 0.9},
            {"bucketId": "gemini-weekly", "window": "weekly", "disabled": True, "remainingFraction": 0.9},
        ]}]}
        w = parse_antigravity_quota_summary(data)
        self.assertEqual(w["5h"].remaining, 0.0)
        self.assertIsNone(w["5h"].reset_at)
        self.assertNotIn("week", w)

        nested = {"groups": [{"displayName": "Gemini Models", "buckets": [
            {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": "0", "resetTime": "bad"},
            {"bucketId": "gemini-weekly", "window": "weekly",
             "remaining": {"remainingFraction": 0.55}, "resetTime": "0"},
        ]}]}
        w2 = parse_antigravity_quota_summary(nested)
        self.assertEqual(w2["5h"].remaining, 0.0)
        self.assertIsNone(w2["5h"].reset_at)
        self.assertAlmostEqual(w2["week"].remaining, 55.0)
        self.assertIsNone(w2["week"].reset_at)

    def test_status_fallback_filters_to_gemini_only(self):
        now = 1_700_000_000
        iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
        data = {"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": "Gemini 4 Neon (High)", "modelOrAlias": {"model": "gemini-4-neon-high"},
             "quotaInfo": {"remainingFraction": 0.8, "resetTime": iso(now + 3600)}},
            {"label": "Claude Opus 4.6 (Thinking)", "modelOrAlias": {"model": "claude-opus-4-6"},
             "quotaInfo": {"remainingFraction": 0.1, "resetTime": iso(now + 3600)}},
            {"label": "Gemini 3.8 Flash", "quotaInfo": {"remainingFraction": 0.6, "resetTime": iso(now + 4 * 86400)}},
        ]}}}
        w = parse_antigravity_status(data, now=now)
        self.assertAlmostEqual(w["5h"].remaining, 80.0)
        self.assertAlmostEqual(w["week"].remaining, 60.0)

        explicit = {"weeklyQuota": {"remainingFraction": 0.25, "resetTime": "2099-01-01T00:00:00Z"},
                    "fiveHourQuota": {"remainingFraction": 0.5}}
        w2 = parse_antigravity_status(explicit)
        self.assertEqual(w2["week"].remaining, 25.0)
        self.assertEqual(w2["5h"].remaining, 50.0)


class AntigravityDiscoveryTest(unittest.TestCase):
    def test_cmdline_and_standalone(self):
        cmd = ('language_server.exe --standalone --app_data_dir antigravity '
               '--csrf_token abc-123 --extension_server_port 51000')
        self.assertTrue(is_standalone_cmdline(cmd))
        self.assertFalse(is_standalone_cmdline('language_server.exe --other'))
        self.assertEqual(parse_cmdline_args(cmd), {
            "csrf_token": "abc-123",
            "extension_server_port": "51000",
            "app_data_dir": "antigravity",
        })

    def test_resolve_daemon_credential(self):
        inline = resolve_daemon_credential("language_server --csrf_token=inline-tok", 99)
        self.assertEqual(inline, {"csrf": "inline-tok", "http_port": None, "https_port": None})

        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "hub_stale.json"), "w", encoding="utf-8") as f:
                json.dump({"pid": 111, "httpPort": 60000, "httpsPort": 60001, "csrfToken": "stale"}, f)
            with open(os.path.join(tmp, "hub_live.json"), "w", encoding="utf-8") as f:
                json.dump({"pid": 21141, "httpPort": 60252, "httpsPort": 60251, "csrfToken": "daemon-tok"}, f)

            cred = resolve_daemon_credential(
                "language_server --standalone --app_data_dir antigravity",
                21141, ports=[60251, 60252], daemon_dir=tmp,
            )
            self.assertEqual(cred, {"csrf": "daemon-tok", "http_port": 60252, "https_port": 60251})
            self.assertIsNone(resolve_daemon_credential("language_server --standalone", 999, daemon_dir=tmp))

    def test_log_ports_newest_first_and_large_file(self):
        text = "listening on random port at 1111 for HTTP\nlistening on random port at 2222 for HTTP\n"
        self.assertEqual(parse_http_log_ports(text), [2222, 1111])

        with tempfile.TemporaryDirectory() as tmp:
            tail_log = os.path.join(tmp, "tail.log")
            with open(tail_log, "wb") as f:
                f.write(b"listening on random port at 1111 for HTTP\n")
                f.write(b"x" * (600 * 1024))
                f.write(b"\nlistening on random port at 2222 for HTTP\n")
            self.assertEqual(read_log_http_ports([tail_log])[0], 2222)

            head_log = os.path.join(tmp, "head.log")
            with open(head_log, "wb") as f:
                f.write(b"listening on random port at 3333 for HTTP\n")
                f.write(b"y" * (700 * 1024))
            self.assertEqual(read_log_http_ports([head_log]), [3333])

    def test_netstat_languages_and_tun_rejection(self):
        out = (
            "  TCP    198.18.0.1:60000   198.18.0.12:0   LISTENING   42\n"
            "  TCP    127.0.0.1:51001    0.0.0.0:0       侦听        42\n"
            "  TCP    [::1]:51004        [::]:0          监听        42\n"
            "  TCP    127.0.0.1:51002    0.0.0.0:0       LISTENING   7\n"
            "  TCP    127.0.0.1:51003    127.0.0.1:1     ESTABLISHED 42\n"
        )
        ports_by_pid, rejected = parse_netstat_snapshot(out)
        self.assertIn(42, rejected)
        self.assertEqual(ports_by_pid[42], [51001, 51004])
        self.assertEqual(parse_netstat_ports(out, 42), [51001, 51004])

    def test_net_tcp_connections(self):
        rows = [
            {"OwningProcess": 42, "LocalAddress": "127.0.0.1", "LocalPort": 51001,
             "RemoteAddress": "0.0.0.0", "RemotePort": 0, "State": 0},
            {"OwningProcess": 42, "LocalAddress": "::1", "LocalPort": 51002,
             "RemoteAddress": "::", "RemotePort": 0, "State": "Listen"},
            {"OwningProcess": 42, "LocalAddress": "127.0.0.1", "LocalPort": 51003,
             "RemoteAddress": "0.0.0.0", "RemotePort": 0, "State": "Closed"},
            {"OwningProcess": 42, "LocalAddress": "198.18.0.1", "LocalPort": 51004,
             "RemoteAddress": "0.0.0.0", "RemotePort": 0, "State": 2},
            {"OwningProcess": 42, "LocalAddress": "127.0.0.1", "LocalPort": 51005,
             "RemoteAddress": "0.0.0.0", "RemotePort": 0, "State": None},
            {"OwningProcess": 42, "LocalAddress": "127.0.0.1", "LocalPort": 51006,
             "RemoteAddress": "0.0.0.0", "RemotePort": 0, "State": ""},
        ]
        probed = []
        ports = parse_net_tcp_connections(
            "\ufeff" + json.dumps(rows), 42, preferred_port=51005,
            probe=lambda p: probed.append(p) or True,
        )
        self.assertEqual(ports, [51001, 51002, 51005])
        self.assertEqual(probed, [51005])


class AntigravityRpcTest(unittest.TestCase):
    @staticmethod
    def _provider(port: int) -> AntigravityProvider:
        prov = AntigravityProvider()
        prov._find_servers = lambda: [(123, "language_server.exe --standalone", {})]
        prov._read_log_ports = lambda: [port]
        prov._listening_ports = lambda _pid, preferred_port=None: [port]
        prov._resolve_daemon = lambda _cmd, _pid, _ports: {
            "csrf": "secret-csrf", "http_port": port, "https_port": None,
        }
        return prov

    @staticmethod
    def _make_build_opener(handler, recorded_handlers: list):
        class FakeResponse:
            def __init__(self, data: bytes) -> None:
                self._data = data

            def read(self) -> bytes:
                return self._data

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class FakeOpener:
            def open(self, req, timeout=None):
                del timeout
                return FakeResponse(handler(req))

        def fake_build_opener(*handlers):
            recorded_handlers.append(handlers)
            return FakeOpener()

        return fake_build_opener

    def test_fetch_summary_end_to_end(self):
        seen = {}
        recorded_handlers = []

        def handler(req):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            seen["body"] = json.loads(req.data.decode("utf-8"))
            return json.dumps({"groups": [
                {"displayName": "Gemini Models", "buckets": [
                    {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.75,
                     "resetTime": "2099-01-01T00:00:00Z"},
                    {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.55,
                     "resetTime": "2099-01-05T00:00:00Z"},
                ]},
                {"displayName": "Claude and GPT models", "buckets": [
                    {"bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.05},
                ]},
            ]}).encode("utf-8")

        prov = self._provider(54321)
        with patch("providers.urllib.request.build_opener",
                   side_effect=self._make_build_opener(handler, recorded_handlers)):
            res = prov.fetch(force=True)

        self.assertEqual(res.error, "")
        self.assertEqual(res.source, "本地服务")
        self.assertAlmostEqual(res.windows["5h"].remaining, 75.0)
        self.assertAlmostEqual(res.windows["week"].remaining, 55.0)
        self.assertEqual(
            seen["url"],
            "http://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        )
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["headers"]["x-codeium-csrf-token"], "secret-csrf")
        self.assertEqual(seen["headers"]["connect-protocol-version"], "1")
        self.assertEqual(seen["body"], {"forceRefresh": True})
        self.assertTrue(any(
            isinstance(h, urllib.request.ProxyHandler) and h.proxies == {}
            for h in recorded_handlers[0]
        ))

    def test_fetch_falls_back_to_get_user_status_on_404(self):
        urls = []
        recorded_handlers = []

        def handler(req):
            urls.append(req.full_url)
            if req.full_url.endswith("/RetrieveUserQuotaSummary"):
                raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
            reset_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
            return json.dumps({"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
                {"label": "Gemini 4 Neon (High)",
                 "quotaInfo": {"remainingFraction": 0.9, "resetTime": reset_iso}},
                {"label": "Claude Sonnet",
                 "quotaInfo": {"remainingFraction": 0.1, "resetTime": reset_iso}},
            ]}}}).encode("utf-8")

        prov = self._provider(54322)
        with patch("providers.urllib.request.build_opener",
                   side_effect=self._make_build_opener(handler, recorded_handlers)):
            res = prov.fetch(force=False)

        self.assertEqual(res.error, "")
        self.assertAlmostEqual(res.windows["5h"].remaining, 90.0)
        self.assertEqual(urls, [
            "http://127.0.0.1:54322/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
            "http://127.0.0.1:54322/exa.language_server_pb.LanguageServerService/GetUserStatus",
        ])
        self.assertTrue(all(
            any(isinstance(h, urllib.request.ProxyHandler) and h.proxies == {} for h in hs)
            for hs in recorded_handlers
        ))

    def test_fetch_falls_back_from_http_400_to_https(self):
        urls = []
        recorded_handlers = []

        def handler(req):
            urls.append(req.full_url)
            if req.full_url.startswith("http://"):
                raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, None)
            return json.dumps({"groups": [{"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.65},
            ]}]}).encode("utf-8")

        prov = self._provider(54323)
        with patch("providers.urllib.request.build_opener",
                   side_effect=self._make_build_opener(handler, recorded_handlers)):
            res = prov.fetch(force=False)

        self.assertEqual(res.error, "")
        self.assertAlmostEqual(res.windows["5h"].remaining, 65.0)
        self.assertEqual(urls, [
            "http://127.0.0.1:54323/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
            "https://127.0.0.1:54323/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        ])
        https_call_handlers = recorded_handlers[1]
        self.assertTrue(any(
            isinstance(h, urllib.request.ProxyHandler) and h.proxies == {}
            for h in https_call_handlers
        ))
        self.assertTrue(any(isinstance(h, urllib.request.HTTPSHandler) for h in https_call_handlers))


if __name__ == "__main__":
    unittest.main()
