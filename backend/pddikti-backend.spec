import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

project_root = os.path.abspath(os.path.join(SPECPATH, ".."))

psycopg_datas, psycopg_binaries, psycopg_hidden = collect_all("psycopg")
psycopg_hidden = [name for name in psycopg_hidden if ".tests" not in name and ".test" not in name]
psycopg_datas = [
    item for item in psycopg_datas
    if not item[0].lower().endswith((".py", ".pyi", ".pyc"))
    and "__pycache__" not in item[0].lower()
    and "tests" not in item[0].lower()
]
hiddenimports = psycopg_hidden + collect_submodules("sqlalchemy.dialects.postgresql") + [
    "scraper.diktis_data",
    "scraper.dosen_scraper",
    "scraper.excel_export",
    "scraper.fetch_prodi",
    "scraper.prodi_enrichment",
    "scraper.accreditation_sources",
    "scraper.target_prodi",
]

a = Analysis(
    [os.path.join(SPECPATH, "desktop_entry.py")],
    pathex=[project_root],
    binaries=psycopg_binaries,
    datas=psycopg_datas,
    hiddenimports=hiddenimports,
    excludes=["pytest", "unittest", "tkinter"],
    optimize=2,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="pddikti-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    exclude_binaries=False,
)
