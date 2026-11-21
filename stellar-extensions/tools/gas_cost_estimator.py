#!/usr/bin/env python3
"""Estimate Soroban gas costs for StellarHunts contracts and gate budgets.

The tool runs a contract's benchmark suite inside the `cargo test` sandbox,
parses the CPU-instruction and memory measurements it prints, and compares
them against `onchain/bench-baselines.json` (the same file CI enforces via
`scripts/check-bench-budgets.py`).

Every measured operation is reported with its cost breakdown, the share of
its budget it consumed, and rule-based optimisation hints for anything that
exceeds or gets close to its ceiling.

Examples
--------
Run the benchmarks for one contract and report:

    python3 stellar-extensions/tools/gas_cost_estimator.py --contract stellar-hunts

Analyse output captured elsewhere (no cargo run):

    cargo test --manifest-path onchain/Cargo.toml -- bench_ --nocapture \\
        | tee /tmp/bench.txt
    python3 stellar-extensions/tools/gas_cost_estimator.py \\
        --contract stellar-hunts --input /tmp/bench.txt

Machine-readable report:

    python3 stellar-extensions/tools/gas_cost_estimator.py \\
        --contract stellar-hunts --input /tmp/bench.txt --json

Exit status is 1 when any operation exceeds its budget or a budgeted metric
is missing from the output, so the command can be used directly in CI.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASELINES = REPO_ROOT / "onchain" / "bench-baselines.json"

# Words used by the benchmark naming convention (`ten_submit_answers_avg_cpu`).
NUMBER_WORDS = {
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
    11: "eleven",
    12: "twelve",
    13: "thirteen",
    14: "fourteen",
    15: "fifteen",
    16: "sixteen",
    17: "seventeen",
    18: "eighteen",
    19: "nineteen",
    20: "twenty",
}

BUDGET_LINE = re.compile(
    r"(?P<operation>[A-Za-z][A-Za-z0-9_ ]*?)\s+budget\s+"
    r"cpu=(?P<cpu>\d+)\s+mem=(?P<mem>\d+)\s*bytes"
)
AGGREGATE_LINE = re.compile(
    r"(?P<count>\d+)x\s+(?P<operation>[A-Za-z][A-Za-z0-9_]*)\s+"
    r"total_cpu=(?P<total>\d+)\s+avg_cpu=(?P<avg>\d+)"
)

# Heuristics keyed by the metric suffix used in the baselines file.
SUGGESTIONS = {
    "cpu": [
        "Cache repeated storage reads in locals; every ledger read costs CPU instructions.",
        "Prefer short Symbol/String values and avoid formatting strings in the hot path.",
        "Move argument-independent validation out of the entry point into init/setup.",
    ],
    "mem": [
        "Avoid cloning Vec/Map/String values; move or borrow them instead.",
        "Shrink stored structs and temporary buffers, and drop unused ledger fields.",
        "Process large batches in chunks so peak allocation stays bounded.",
    ],
    "avg_cpu": [
        "Reset per-iteration fixtures outside the measured call to isolate steady-state work.",
        "Check for per-call initialisation that belongs in init instead.",
        "Look for accumulating storage writes across repeated calls.",
    ],
}

STATUS_OK = "ok"
STATUS_OVER = "over"
STATUS_MISSING = "missing"


@dataclass
class CostRow:
    """One measured metric for one contract operation."""

    operation: str
    metric: str
    measured: int | None
    budget: int
    unit: str
    notes: str = ""
    suggestions: list[str] = field(default_factory=list)

    @property
    def ratio(self) -> float | None:
        if self.measured is None or self.budget == 0:
            return None
        return self.measured / self.budget

    @property
    def status(self) -> str:
        if self.measured is None:
            return STATUS_MISSING
        return STATUS_OK if self.measured <= self.budget else STATUS_OVER

    def to_dict(self) -> dict:
        return {
            "operation": self.operation,
            "metric": self.metric,
            "measured": self.measured,
            "max": self.budget,
            "unit": self.unit,
            "ratio": round(self.ratio, 4) if self.ratio is not None else None,
            "status": self.status,
            "notes": self.notes,
            "suggestions": self.suggestions,
        }


def _snake(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def parse_measurements(text: str) -> dict[str, int]:
    """Extract metric values from captured benchmark output.

    Two line shapes are understood, matching the conventions already used by
    `onchain/contracts/stellar_hunts/src/bench.rs`:

        submit_answer budget        cpu=250000 mem=4096 bytes
        10x submit_answer  total_cpu=2000000 avg_cpu=200000

    Budget lines yield `<operation>_cpu` and `<operation>_mem`; aggregate
    lines yield both `<count>x_<operation>_avg_cpu` and the word form
    `<ten>_<operation>_avg_cpu`.
    """

    measurements: dict[str, int] = {}

    for line in text.splitlines():
        budget_match = BUDGET_LINE.search(line)
        if budget_match:
            operation = _snake(budget_match.group("operation"))
            measurements[f"{operation}_cpu"] = int(budget_match.group("cpu"))
            measurements[f"{operation}_mem"] = int(budget_match.group("mem"))
            continue

        aggregate_match = AGGREGATE_LINE.search(line)
        if aggregate_match:
            operation = _snake(aggregate_match.group("operation"))
            count = int(aggregate_match.group("count"))
            average = int(aggregate_match.group("avg"))
            measurements[f"{count}x_{operation}_avg_cpu"] = average
            word = NUMBER_WORDS.get(count)
            if word:
                measurements[f"{word}_{operation}_avg_cpu"] = average

    return measurements


def _metric_suffix(metric: str) -> str:
    for suffix in ("avg_cpu", "cpu", "mem"):
        if metric.endswith(f"_{suffix}"):
            return suffix
    return "cpu"


def _operation_for(metric: str) -> str:
    """Derive the operation name a baseline metric belongs to."""
    if metric.endswith("_avg_cpu"):
        base = metric[: -len("_avg_cpu")]
        aggregate = re.match(r"^(?:\d+x|[a-z]+)_(?P<operation>.+)$", base)
        return aggregate.group("operation") if aggregate else base
    suffix = _metric_suffix(metric)
    return metric[: -(len(suffix) + 1)]


def _normalize_metric(metric: str) -> str:
    """Fold singular/plural differences used by benchmark labels.

    The captured bench label (`10x submit_answer`) and the baseline key
    (`ten_submit_answers_avg_cpu`) disagree on plurality, so matching is done
    on a normalized form rather than requiring identical names.
    """
    return "_".join(
        token[:-1] if len(token) > 3 and token.endswith("s") else token
        for token in metric.lower().split("_")
    )


def _lookup_measurement(measurements: dict[str, int], metric: str) -> int | None:
    if metric in measurements:
        return measurements[metric]
    normalized = {_normalize_metric(key): value for key, value in measurements.items()}
    return normalized.get(_normalize_metric(metric))


def suggestions_for(metric: str, measured: int, budget: int) -> list[str]:
    """Rule-based optimisation hints for a metric that is over or near budget."""
    hints = list(SUGGESTIONS.get(_metric_suffix(metric), SUGGESTIONS["cpu"]))
    if budget > 0:
        ratio = measured / budget
        if ratio > 1.5:
            hints.append(
                f"Cost is {ratio:.1f}x the documented ceiling; profile the hot path "
                "before raising the baseline."
            )
        elif ratio > 0.9:
            hints.append(
                "Close to the ceiling already; add headroom before widening the feature."
            )
    return hints


def evaluate(
    baselines: dict,
    measurements: dict[str, int],
    suggest_threshold: float = 0.9,
) -> list[CostRow]:
    """Compare measurements against baselines and annotate over-budget rows."""

    rows: list[CostRow] = []
    for metric, spec in baselines.items():
        budget = int(spec["max"])
        measured = _lookup_measurement(measurements, metric)
        row = CostRow(
            operation=_operation_for(metric),
            metric=metric,
            measured=measured,
            budget=budget,
            unit=spec.get("unit", ""),
            notes=spec.get("notes", ""),
        )
        if measured is not None and measured >= budget * suggest_threshold:
            row.suggestions = suggestions_for(metric, measured, budget)
        rows.append(row)

    rows.sort(key=lambda row: (row.operation, row.metric))
    return rows


def resolve_contract(contract: str, root: Path = REPO_ROOT) -> Path:
    """Resolve a contract name or path to its Cargo manifest."""

    candidate = Path(contract)
    if candidate.suffix == ".toml":
        return candidate if candidate.is_absolute() else root / candidate

    candidates = [
        candidate,
        root / "onchain" / "contracts" / contract,
        root / "stellar-extensions" / "onchain" / "contracts" / contract,
    ]
    # Accept the hyphenated crate name as well as the snake_case directory.
    underscored = contract.replace("-", "_")
    if underscored != contract:
        candidates.extend(
            [
                root / "onchain" / "contracts" / underscored,
                root / "stellar-extensions" / "onchain" / "contracts" / underscored,
            ]
        )

    for path in candidates:
        path = path if path.is_absolute() else root / path
        manifest = path if path.name == "Cargo.toml" else path / "Cargo.toml"
        if manifest.is_file():
            return manifest

    raise FileNotFoundError(
        f"Could not find a contract named {contract!r} under "
        f"{root / 'onchain' / 'contracts'} or "
        f"{root / 'stellar-extensions' / 'onchain' / 'contracts'}"
    )


def run_benchmarks(manifest: Path, cargo: str = "cargo", timeout: int = 600) -> str:
    """Run a contract's benchmark tests and return their captured stdout."""

    command = [
        cargo,
        "test",
        "--manifest-path",
        str(manifest),
        "--",
        "--nocapture",
        "bench",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "cargo was not found on PATH. Install Rust/Soroban CLI or pass "
            "--input with previously captured benchmark output."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"benchmark run timed out after {timeout}s") from exc

    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        tail = "\n".join(output.strip().splitlines()[-15:])
        raise RuntimeError(f"cargo test failed (exit {completed.returncode}):\n{tail}")
    return output


def _format_number(value: int | None) -> str:
    return "n/a" if value is None else f"{value:,}"


def render_table(rows: Iterable[CostRow]) -> str:
    """Render a human-readable breakdown table."""

    header = (
        f"{'Operation':<24} {'Metric':<30} {'Measured':>14} "
        f"{'Budget':>14} {'Used':>8}  Status"
    )
    separator = "-" * len(header)
    lines = [header, separator]
    for row in rows:
        used = f"{row.ratio * 100:.0f}%" if row.ratio is not None else "n/a"
        status = {
            STATUS_OK: "OK",
            STATUS_OVER: "OVER BUDGET",
            STATUS_MISSING: "MISSING",
        }[row.status]
        lines.append(
            f"{row.operation:<24} {row.metric:<30} "
            f"{_format_number(row.measured):>14} {row.budget:>14,} "
            f"{used:>8}  {status}"
        )
    lines.append(separator)
    return "\n".join(lines)


def build_report(
    contract: str,
    baselines_path: Path,
    rows: list[CostRow],
) -> dict:
    over = [row.metric for row in rows if row.status == STATUS_OVER]
    missing = [row.metric for row in rows if row.status == STATUS_MISSING]
    by_operation: dict[str, list[dict]] = {}
    for row in rows:
        by_operation.setdefault(row.operation, []).append(row.to_dict())

    total_cpu = sum(
        row.measured
        for row in rows
        if row.measured is not None
        and row.metric.endswith("_cpu")
        and not row.metric.endswith("_avg_cpu")
    )

    return {
        "contract": contract,
        "baselines": str(baselines_path),
        "summary": {
            "metrics": len(rows),
            "over_budget": over,
            "missing": missing,
            "total_cpu": total_cpu,
            "passed": not over and not missing,
        },
        "operations": by_operation,
        "suggestions": {
            row.metric: row.suggestions for row in rows if row.suggestions
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure Soroban contract gas usage and compare it with "
            "onchain/bench-baselines.json."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--contract",
        default="stellar-hunts",
        help="Contract name (e.g. stellar-hunts) or path to its Cargo manifest.",
    )
    parser.add_argument(
        "--baselines",
        type=Path,
        default=DEFAULT_BASELINES,
        help="Budget baseline JSON file.",
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="Read captured benchmark output instead of running cargo.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON report.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Seconds to wait for the benchmark run.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        baselines_doc = json.loads(args.baselines.read_text())
    except FileNotFoundError:
        print(f"Baselines file not found: {args.baselines}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"Invalid baselines JSON at {args.baselines}: {exc}", file=sys.stderr)
        return 2

    if args.input:
        bench_output = args.input.read_text()
    else:
        try:
            manifest = resolve_contract(args.contract)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        try:
            cargo = shutil.which("cargo") or "cargo"
            bench_output = run_benchmarks(manifest, cargo=cargo, timeout=args.timeout)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 2

    measurements = parse_measurements(bench_output)
    rows = evaluate(baselines_doc.get("benchmarks", {}), measurements)
    report = build_report(args.contract, args.baselines, rows)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(
            f"Gas cost estimate for {args.contract} "
            f"(baselines: {args.baselines})\n"
        )
        print(render_table(rows))
        print(f"\nTotal measured CPU: {report['summary']['total_cpu']:,}")

        flagged = [row for row in rows if row.suggestions]
        if flagged:
            print("\nOptimisation hints:")
            for row in flagged:
                print(f"\n  {row.metric} ({_format_number(row.measured)} / {row.budget:,}):")
                for hint in row.suggestions:
                    print(f"    - {hint}")

        if report["summary"]["missing"]:
            print(
                "\nMissing measurements (did the bench run?): "
                + ", ".join(report["summary"]["missing"]),
                file=sys.stderr,
            )
        if report["summary"]["over_budget"]:
            print(
                "\nOperations exceeding budget: "
                + ", ".join(report["summary"]["over_budget"]),
                file=sys.stderr,
            )

    return 0 if report["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
