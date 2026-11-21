#!/usr/bin/env python3
"""Unit tests for the gas cost estimator (stdlib unittest, no extra deps)."""

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gas_cost_estimator as gas  # noqa: E402


BENCH_OUTPUT = """
running 2 tests
test bench::bench_submit_answer ... submit_answer budget        cpu=123456 mem=4096 bytes
test bench::bench_ten_submit_answers ... 10x submit_answer  total_cpu=900000 avg_cpu=90000
test result: ok. 2 passed
"""

BASELINES = {
    "submit_answer_cpu": {
        "max": 500000,
        "unit": "instructions",
        "notes": "Single call.",
    },
    "submit_answer_mem": {"max": 8192, "unit": "bytes"},
    "ten_submit_answers_avg_cpu": {"max": 100000, "unit": "instructions"},
}


class ParseMeasurementsTests(unittest.TestCase):
    def test_parses_budget_and_aggregate_lines(self):
        measurements = gas.parse_measurements(BENCH_OUTPUT)

        self.assertEqual(measurements["submit_answer_cpu"], 123456)
        self.assertEqual(measurements["submit_answer_mem"], 4096)
        self.assertEqual(measurements["10x_submit_answer_avg_cpu"], 90000)
        self.assertEqual(measurements["ten_submit_answer_avg_cpu"], 90000)

    def test_ignores_unrelated_output(self):
        self.assertEqual(gas.parse_measurements("test result: ok. 2 passed"), {})

    def test_does_not_confuse_budget_and_aggregate_lines(self):
        measurements = gas.parse_measurements(BENCH_OUTPUT)
        self.assertNotIn("10x_submit_answer_cpu", measurements)


class EvaluateTests(unittest.TestCase):
    def test_marks_measurements_within_budget_as_ok(self):
        rows = gas.evaluate(BASELINES, gas.parse_measurements(BENCH_OUTPUT))

        self.assertTrue(all(row.status == gas.STATUS_OK for row in rows), rows)
        self.assertEqual(
            [row.measured for row in rows], [123456, 4096, 90000]
        )

    def test_flags_operations_exceeding_budget_with_suggestions(self):
        output = "submit_answer budget cpu=900000 mem=4096 bytes"
        rows = gas.evaluate(BASELINES, gas.parse_measurements(output))

        cpu_row = next(row for row in rows if row.metric.endswith("_cpu"))
        self.assertEqual(cpu_row.status, gas.STATUS_OVER)
        self.assertGreater(len(cpu_row.suggestions), 0)
        self.assertTrue(
            any("profile the hot path" in hint for hint in cpu_row.suggestions)
        )

    def test_reports_missing_measurements(self):
        rows = gas.evaluate(BASELINES, {})
        self.assertTrue(
            all(row.status == gas.STATUS_MISSING for row in rows), rows
        )

    def test_suggests_optimisation_near_the_ceiling(self):
        output = "submit_answer budget cpu=460000 mem=4096 bytes"
        rows = gas.evaluate(BASELINES, gas.parse_measurements(output))
        cpu_row = next(row for row in rows if row.metric.endswith("_cpu"))

        self.assertEqual(cpu_row.status, gas.STATUS_OK)
        self.assertTrue(
            any("headroom" in hint for hint in cpu_row.suggestions),
            cpu_row.suggestions,
        )

    def test_groups_metrics_by_operation(self):
        rows = gas.evaluate(BASELINES, gas.parse_measurements(BENCH_OUTPUT))
        operations = {row.operation for row in rows}

        self.assertIn("submit_answer", operations)
        self.assertIn("submit_answers", operations)


class ContractResolutionTests(unittest.TestCase):
    def test_resolves_the_core_game_contract(self):
        manifest = gas.resolve_contract("stellar-hunts")
        self.assertEqual(
            manifest, gas.REPO_ROOT / "onchain" / "contracts" / "stellar_hunts" / "Cargo.toml"
        )

    def test_resolves_an_extension_contract(self):
        manifest = gas.resolve_contract("puzzle-governance")
        self.assertTrue(manifest.is_file())
        self.assertIn("stellar-extensions", str(manifest))

    def test_accepts_an_explicit_manifest_path(self):
        manifest = gas.resolve_contract(
            "stellar-extensions/onchain/contracts/puzzle_governance/Cargo.toml"
        )
        self.assertTrue(manifest.is_file())

    def test_unknown_contract_raises(self):
        with self.assertRaises(FileNotFoundError):
            gas.resolve_contract("does-not-exist")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.baselines = self.dir / "baselines.json"
        self.baselines.write_text(json.dumps({"benchmarks": BASELINES}))
        self.output = self.dir / "bench.txt"

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = gas.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_passing_run_exits_zero(self):
        self.output.write_text(BENCH_OUTPUT)
        code, stdout, _ = self.run_cli(
            "--contract", "stellar-hunts",
            "--baselines", str(self.baselines),
            "--input", str(self.output),
        )

        self.assertEqual(code, 0)
        self.assertIn("Gas cost estimate for stellar-hunts", stdout)

    def test_over_budget_run_exits_one(self):
        self.output.write_text("submit_answer budget cpu=900000 mem=4096 bytes")
        code, _, stderr = self.run_cli(
            "--contract", "stellar-hunts",
            "--baselines", str(self.baselines),
            "--input", str(self.output),
        )

        self.assertEqual(code, 1)
        self.assertIn("exceeding budget", stderr)

    def test_json_report_is_valid_and_complete(self):
        self.output.write_text(BENCH_OUTPUT)
        code, stdout, _ = self.run_cli(
            "--contract", "stellar-hunts",
            "--baselines", str(self.baselines),
            "--input", str(self.output),
            "--json",
        )

        self.assertEqual(code, 0)
        report = json.loads(stdout)
        self.assertTrue(report["summary"]["passed"])
        self.assertIn("submit_answer", report["operations"])
        self.assertEqual(report["summary"]["total_cpu"], 123456)

    def test_missing_baselines_file_exits_two(self):
        code, _, stderr = self.run_cli(
            "--baselines", str(self.dir / "nope.json"),
            "--input", str(self.output),
        )
        self.assertEqual(code, 2)
        self.assertIn("Baselines file not found", stderr)


if __name__ == "__main__":
    unittest.main()
