"""One-time importer for legacy Excel outputs into PostgreSQL."""

from __future__ import annotations

import argparse
import uuid
from pathlib import Path

from backend.config import settings

from backend.database import (
    complete_scrape_run,
    create_scrape_run,
    excel_rows,
    fail_scrape_run,
    persist_scrape_results,
)

OUTPUT_DIR = settings.output_dir


def import_file(path: Path) -> dict[str, int]:
    run_id = str(uuid.uuid4())
    create_scrape_run(run_id, [f"legacy-import:{path.name}"])
    try:
        profiles, prodi_list = excel_rows(path)
        stats = persist_scrape_results(run_id, profiles, prodi_list)
        complete_scrape_run(run_id, path.name)
        return stats
    except Exception as exc:
        fail_scrape_run(run_id, exc)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Impor hasil Excel lama ke PostgreSQL dengan deduplikasi.")
    parser.add_argument("paths", nargs="*", type=Path, help="File .xlsx yang akan diimpor")
    parser.add_argument("--all", action="store_true", help="Impor seluruh file .xlsx di folder output")
    args = parser.parse_args()

    paths = sorted(OUTPUT_DIR.glob("*.xlsx")) if args.all else args.paths
    paths = [path.resolve() for path in paths if path.suffix.lower() == ".xlsx" and path.exists()]
    if not paths:
        parser.error("Tidak ada file .xlsx yang valid untuk diimpor.")

    totals = {
        "dosen_seen": 0, "dosen_inserted": 0, "dosen_updated": 0, "dosen_skipped": 0,
        "prodi_seen": 0, "prodi_inserted": 0, "prodi_updated": 0, "prodi_skipped": 0,
    }
    for path in paths:
        stats = import_file(path)
        for key, value in stats.items():
            totals[key] += value
        print(
            f"{path.name}: dosen baru={stats['dosen_inserted']}, "
            f"dosen dilewati={stats['dosen_skipped']}, prodi baru={stats['prodi_inserted']}, "
            f"prodi dilewati={stats['prodi_skipped']}"
        )

    print(
        f"Selesai: {totals['dosen_inserted']} dosen baru dan "
        f"{totals['prodi_inserted']} prodi baru dari {len(paths)} file."
    )


if __name__ == "__main__":
    main()
