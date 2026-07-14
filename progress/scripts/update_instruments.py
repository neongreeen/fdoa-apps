#!/usr/bin/env python3
"""Build local instrument search lists from official JPX and SEC datasets."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import xlrd


JPX_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
SEC_URL = "https://www.sec.gov/files/company_tickers_exchange.json"
USER_AGENT = os.environ.get(
    "SEC_USER_AGENT",
    "ProgressPortfolio/0.1 neongreeen@users.noreply.github.com",
)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json,*/*"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def read_source(path: str | None, url: str) -> bytes:
    return Path(path).read_bytes() if path else fetch(url)


def clean_code(value: object) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def parse_jpx(raw: bytes) -> tuple[list[dict], str | None]:
    sheet = xlrd.open_workbook(file_contents=raw).sheet_by_index(0)
    headers = [str(value).strip() for value in sheet.row_values(0)]
    columns = {label: headers.index(label) for label in ("日付", "コード", "銘柄名", "市場・商品区分")}
    instruments = []
    source_date = None
    for row_index in range(1, sheet.nrows):
        row = sheet.row_values(row_index)
        ticker = clean_code(row[columns["コード"]])
        name = str(row[columns["銘柄名"]]).strip()
        market = str(row[columns["市場・商品区分"]]).strip()
        if not ticker or not name:
            continue
        if source_date is None:
            date_value = clean_code(row[columns["日付"]])
            if len(date_value) == 8 and date_value.isdigit():
                source_date = f"{date_value[:4]}-{date_value[4:6]}-{date_value[6:]}"
        instruments.append(
            {
                "id": f"JP:{ticker}",
                "name": name,
                "ticker": ticker,
                "market": market,
                "country": "JP",
                "currency": "JPY",
            }
        )
    return instruments, source_date


def parse_sec(raw: bytes) -> list[dict]:
    payload = json.loads(raw)
    fields = payload.get("fields", [])
    rows = payload.get("data", [])
    positions = {label: fields.index(label) for label in ("cik", "name", "ticker", "exchange")}
    instruments = []
    for row in rows:
        ticker = str(row[positions["ticker"]] or "").strip().upper()
        name = str(row[positions["name"]] or "").strip()
        exchange = str(row[positions["exchange"]] or "").strip()
        cik = clean_code(row[positions["cik"]])
        if not ticker or not name:
            continue
        instruments.append(
            {
                "id": f"US:{exchange}:{ticker}",
                "name": name,
                "ticker": ticker,
                "market": exchange,
                "country": "US",
                "currency": "USD",
                "referenceUrl": f"https://www.sec.gov/edgar/browse/?CIK={cik}",
            }
        )
    return instruments


def validate(items: list[dict], minimum: int, label: str) -> None:
    if len(items) < minimum:
        raise ValueError(f"{label}: expected at least {minimum} records, got {len(items)}")
    keys = [(item["ticker"], item["market"]) for item in items]
    if len(keys) != len(set(keys)):
        raise ValueError(f"{label}: duplicate ticker and market pairs")


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)
    path.chmod(0o644)


def write_if_changed(path: Path, payload: dict) -> bool:
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
            comparable_keys = ("schemaVersion", "source", "sourceUrl", "sourceUpdatedAt", "instruments")
            if all(current.get(key) == payload.get(key) for key in comparable_keys):
                return False
        except (OSError, json.JSONDecodeError):
            pass
    atomic_json(path, payload)
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jpx-input")
    parser.add_argument("--sec-input")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "data"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    updated = []
    failures = []
    successful_sources = 0

    try:
        jpx_items, jpx_date = parse_jpx(read_source(args.jpx_input, JPX_URL))
        validate(jpx_items, 3000, "JPX")
        successful_sources += 1
        if write_if_changed(output_dir / "instruments-jp.json", {
            "schemaVersion": 1,
            "source": "JPX",
            "sourceUrl": JPX_URL,
            "sourceUpdatedAt": jpx_date,
            "generatedAt": generated_at,
            "instruments": jpx_items,
        }):
            updated.append(f"JPX {len(jpx_items)}")
    except Exception as error:  # preserve last-known-good file
        failures.append(f"JPX: {error}")

    try:
        sec_items = parse_sec(read_source(args.sec_input, SEC_URL))
        validate(sec_items, 5000, "SEC")
        successful_sources += 1
        if write_if_changed(output_dir / "instruments-us.json", {
            "schemaVersion": 1,
            "source": "SEC",
            "sourceUrl": SEC_URL,
            "sourceUpdatedAt": None,
            "generatedAt": generated_at,
            "instruments": sec_items,
        }):
            updated.append(f"SEC {len(sec_items)}")
    except Exception as error:  # SEC may reject data-center IPs; keep bundled list
        failures.append(f"SEC: {error}")

    for failure in failures:
        print(f"Warning: {failure}; keeping the existing list", file=sys.stderr)
    missing = [path for path in (output_dir / "instruments-jp.json", output_dir / "instruments-us.json") if not path.exists()]
    if missing:
        raise RuntimeError(f"No usable instrument list: {', '.join(map(str, missing))}")
    if successful_sources == 0:
        raise RuntimeError("All instrument sources failed; existing lists were preserved")
    print("Updated " + ", ".join(updated) if updated else "No instrument changes")


if __name__ == "__main__":
    main()
