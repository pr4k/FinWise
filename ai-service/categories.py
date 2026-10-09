"""Read-only FinWise category export and independent local category catalog."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import quote


def load_categories(path: Path) -> list[dict]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("categories"), list):
        raise ValueError("invalid category snapshot")
    categories = data["categories"]
    ids = set()
    for category in categories:
        if (not isinstance(category, dict) or set(category) != {"id", "name", "kind", "parent_id"}
                or not isinstance(category["id"], str) or not category["id"]
                or not isinstance(category["name"], str) or not category["name"].strip()
                or category["kind"] not in {"expense", "income"}
                or category["parent_id"] is not None and not isinstance(category["parent_id"], str)
                or category["id"] in ids):
            raise ValueError("invalid category entry")
        ids.add(category["id"])
    by_id = {item["id"]: item for item in categories}
    for item in categories:
        parent = item["parent_id"]
        if parent and (parent not in by_id or by_id[parent]["kind"] != item["kind"]):
            raise ValueError("invalid category parent")
    return categories


def category_label(category: dict, by_id: dict[str, dict]) -> str:
    names = [category["name"]]
    seen = {category["id"]}
    parent = category["parent_id"]
    while parent:
        if parent in seen:
            raise ValueError("category hierarchy contains a cycle")
        seen.add(parent)
        item = by_id[parent]
        names.insert(0, item["name"])
        parent = item["parent_id"]
    return " / ".join(names)


def sync_categories(db_path: Path, output: Path, household_id: str | None = None) -> int:
    path = db_path.resolve()
    if not path.is_file():
        raise ValueError(f"FinWise database not found: {path}")
    uri = f"file:{quote(str(path), safe='/')}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        rows = db.execute("SELECT id, household_id, document FROM resources WHERE kind = ?", ("categories",)).fetchall()
    households = {row[1] for row in rows}
    if household_id is None and len(households) > 1:
        raise ValueError("multiple households found; choose one with --household-id")
    if household_id is not None and household_id not in households:
        raise ValueError("household has no categories")
    selected = household_id or next(iter(households), None)
    categories = []
    for id_, household, document in rows:
        if household != selected:
            continue
        item = json.loads(document)
        if item.get("archived"):
            continue
        categories.append({"id": id_, "name": item["name"], "kind": item["kind"],
                           "parent_id": item.get("parent_id")})
    categories.sort(key=lambda item: (item["kind"], item["name"].casefold(), item["id"]))
    snapshot = {"version": 1, "categories": categories}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    load_categories(output)
    return len(categories)
