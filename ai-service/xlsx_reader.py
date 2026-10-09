"""Small, read-only XLSX reader for bank-statement tables (standard library)."""

from __future__ import annotations

import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MAX_UNCOMPRESSED = 50 * 1024 * 1024
MAX_ENTRIES = 1000


def _text(node: ET.Element | None) -> str:
    return "" if node is None else "".join(part.text or "" for part in node.iter(f"{MAIN}t"))


def _column(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference)
    if not letters:
        raise ValueError("invalid XLSX cell reference")
    index = 0
    for letter in letters.group():
        index = index * 26 + ord(letter) - ord("A") + 1
    if index > 256:
        raise ValueError("XLSX has too many columns")
    return index - 1


def read_xlsx(path) -> tuple[list[str], list[dict[str, str]]]:
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise ValueError("invalid XLSX file") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES or sum(item.file_size for item in infos) > MAX_UNCOMPRESSED:
            raise ValueError("XLSX exceeds local import limits")
        names = set(archive.namelist())
        try:
            workbook = ET.fromstring(archive.read("xl/workbook.xml"))
            rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            first_sheet = workbook.find(f"{MAIN}sheets/{MAIN}sheet")
            if first_sheet is None:
                raise ValueError("XLSX has no worksheet")
            rel_id = first_sheet.attrib[f"{REL}id"]
            relation = next(r for r in rels.findall(f"{PKG_REL}Relationship") if r.attrib.get("Id") == rel_id)
            target = relation.attrib["Target"].lstrip("/")
            sheet_path = target if target.startswith("xl/") else f"xl/{target}"
            normalized = str(PurePosixPath(sheet_path))
            if ".." in PurePosixPath(sheet_path).parts or not normalized.startswith("xl/worksheets/"):
                raise ValueError("unsafe XLSX worksheet path")
            shared = []
            if "xl/sharedStrings.xml" in names:
                strings_xml = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = [_text(item) for item in strings_xml.findall(f"{MAIN}si")]
            sheet = ET.fromstring(archive.read(normalized))
        except (KeyError, StopIteration, ET.ParseError, IndexError) as exc:
            raise ValueError("invalid XLSX structure") from exc

    matrix: list[list[str]] = []
    for row in sheet.findall(f"{MAIN}sheetData/{MAIN}row"):
        values: dict[int, str] = {}
        for cell in row.findall(f"{MAIN}c"):
            column = _column(cell.attrib.get("r", ""))
            kind = cell.attrib.get("t")
            if kind == "inlineStr":
                value = _text(cell.find(f"{MAIN}is"))
            else:
                raw = cell.findtext(f"{MAIN}v", default="")
                if kind == "s":
                    try:
                        value = shared[int(raw)]
                    except (ValueError, IndexError) as exc:
                        raise ValueError("invalid XLSX shared string") from exc
                else:
                    value = raw
            values[column] = value
        if values:
            width = max(values) + 1
            matrix.append([values.get(index, "") for index in range(width)])
    required = {"description", "debit", "credit"}
    header_index = next((index for index, row in enumerate(matrix[:25]) if required <= {value.strip().casefold() for value in row}), None)
    if header_index is None:
        raise ValueError("first worksheet needs Description, Debit, and Credit headers in its first 25 rows")
    raw_headers = matrix[header_index]
    headers = [next((name for name in ("Description", "Debit", "Credit") if item.strip().casefold() == name.casefold()), item.strip() or f"Column {index + 1}") for index, item in enumerate(raw_headers)]
    if len(set(headers)) != len(headers):
        raise ValueError("duplicate XLSX column headers")
    rows = [{header: (row[index] if index < len(row) else "") for index, header in enumerate(headers)}
            for row in matrix[header_index + 1:] if any(value.strip() for value in row)]
    return headers, rows
