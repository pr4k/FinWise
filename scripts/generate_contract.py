#!/usr/bin/env python3
"""Generate the implemented API contract and browser types. No third-party tools required."""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
S = {"type": "string"}
I = {"type": "integer"}
B = {"type": "boolean"}
M = {"type": "string", "pattern": r"^-?\d+(\.\d+)?$", "description": "Exact decimal money; never a JSON number."}
D = {"type": "string", "format": "date"}

def ref(name):
    return {"$ref": f"#/components/schemas/{name}"}

def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required)}

def arr(value):
    return {"type": "array", "items": value}

def enum(*values):
    return {"type": "string", "enum": values}

schemas = {
    "Money": obj({"amount": M, "currency": S}, ("amount", "currency")),
    "Error": obj({"error": obj({"code": S, "message": S, "fields": arr(obj({"path": S, "code": S, "message": S})), "current_revision": I}, ("code", "message", "fields")), "request_id": S}, ("error", "request_id")),
    "LoginInput": obj({"email": S, "password": {"type":"string","writeOnly":True}}, ("email","password")),
    "Owner": obj({"name": S, "email": {"type": "string", "format": "email"}, "password": {"type": "string", "minLength": 12, "maxLength": 1024, "writeOnly": True}}, ("name", "email", "password")),
    "HouseholdInput": obj({"name": S, "timezone": S, "base_currency": S}, ("name", "timezone", "base_currency")),
    "AccountInput": obj({"name": S, "subtype": enum("bank", "credit_card", "cash", "settle_up"), "currency": S, "timezone": S, "aliases": arr(S), "visibility": enum("private", "shared"), "active": B, "opening_balance": obj({"amount": M, "as_of": {"type":"string","format":"date-time"}}, ("amount","as_of")), "card_due": obj({"amount": M, "due_date": D}, ("due_date",))}, ("name", "subtype", "currency")),
    "CategoryInput": obj({"name": S, "kind": enum("expense", "income"), "parent_id": {"type": ["string", "null"]}}, ("name", "kind")),
    "Movement": obj({"account_id": S, "amount": M}, ("account_id", "amount")),
    "Allocation": obj({"category_id": {"type": ["string", "null"]}, "amount": M, "scope": enum("personal", "family"), "beneficiary_id": S}, ("amount", "scope")),
    "TransactionInput": obj({"event_type": enum("expense", "income", "refund", "transfer"), "amount": M, "currency": S, "effective_date": D, "effective_at": {"type":"string","format":"date-time"}, "description": S, "merchant": S, "movements": arr(ref("Movement")), "allocations": arr(ref("Allocation"))}, ("event_type", "amount", "currency", "effective_date", "movements", "allocations")),
    "BudgetLine": obj({"category_id": S, "amount": M}, ("category_id", "amount")),
    "BudgetInput": obj({"name": S, "month": {"type": "string", "pattern": r"^\d{4}-\d{2}$"}, "scope": enum("personal", "family"), "currency": S, "expected_income": M, "lines": arr(ref("BudgetLine")), "targets": obj({})}, ("month", "scope", "currency", "expected_income", "lines")),
    "Revision": obj({"expected_revision": I}),
    "Reason": obj({"expected_revision": I, "reason": S}, ("reason",)),
    "InviteInput": obj({"email": S, "role": enum("admin", "member"), "token": {"type": "string", "pattern": "^[a-fA-F0-9]{64}$", "writeOnly": True, "description": "Generate 32 random bytes in the client; transmit the token to the invitee privately. Server persists only its hash."}, "expires_at": {"type": "string", "format": "date-time"}}, ("email", "role", "token")),
}
schemas["BootstrapInput"] = obj({"owner": ref("Owner"), "household": ref("HouseholdInput")}, ("owner", "household"))
for name in ["Account", "Category", "Transaction", "Budget"]:
    source = schemas[name + "Input"]
    props = dict(source["properties"], id=S, revision=I, owner_id=S, created_at=S)
    if name == "Transaction":
        props.update(voided=B, entered_by=S, source_refs=arr(obj({})), reconciliation_state=S, reconciliation_evidence=arr(obj({})), amendment=obj({"id":S,"original_amount":M,"original_date":D,"reason":S,"status":S}), money_manager_synced_at=S, money_manager_manual_edit=obj({"updated_at":S}), reconciliation_created=obj({"action":S,"reason":S}))
    if name == "Category":
        props.update(archived=B)
    if name == "Budget":
        props.update(state=enum("draft", "active", "archived"))
    if name == "Account":
        props.update(balance=obj({"amount": {"type": ["string", "null"]}, "currency": S, "basis": S, "as_of": {"type": ["string", "null"]}, "complete": B, "coverage": S, "source": enum("opening_balance", "balance_check", "unknown"), "anchor_at": {"type": ["string", "null"]}}))
    schemas[name] = obj(props, list(source["required"]) + ["id", "revision", "owner_id", "created_at"])
    schemas[name + "Patch"] = obj(dict(source["properties"], expected_revision=I))
    schemas[name + "Collection"] = obj({"data": arr(ref(name)), "page": obj({"next_cursor": S}), "meta": obj({})}, ("data", "page", "meta"))

paths = {}

def route(path, method, response=None, request=None, public=False, revision=False, implemented=True, parameters=()):
    status = "201" if method == "post" and path in ["/auth/bootstrap", "/accounts", "/categories", "/transactions", "/budgets"] or method == "post" and path.endswith(("/balance-checks", "/copy")) or method == "post" and path.endswith("/invites") else "200"
    if method == "delete" or path == "/auth/logout":
        status = "204"
    params = [{"name": part[1:-1], "in": "path", "required": True, "schema": S} for part in path.split("/") if part.startswith("{")]
    params += [{"name": p, "in": "query", "schema": S} for p in parameters]
    if method == "post" and path not in ["/auth/login", "/auth/logout"]:
        params.append({"name": "Idempotency-Key", "in": "header", "required": True, "schema": S})
    if revision:
        params.append({"name": "If-Match", "in": "header", "description": "Required unless expected_revision is in the body.", "schema": S})
    if method not in ["get"] and not public:
        params.append({"name": "X-CSRF-Token", "in": "header", "required": True, "schema": S})
    item = {"operationId": method + "_" + path.strip("/").replace("/", "_").replace("{", "").replace("}", "").replace("-", "_"), "security": [] if public else [{"session": []}], "parameters": params, "x-implemented": implemented, "responses": {"default": {"description": "Standard API error", "content": {"application/json": {"schema": ref("Error")}}}}}
    if implemented:
        item["responses"][status] = {"description": "Success"}
        if status != "204":
            item["responses"][status]["content"] = {"application/json": {"schema": ref(response) if response else obj({})}}
    else:
        item["responses"]["501"] = {"description": "Explicitly unavailable in the core release", "content": {"application/json": {"schema": ref("Error")}}}
    if request:
        item["requestBody"] = {"required": True, "content": {"application/json": {"schema": ref(request)}}}
    paths.setdefault(path, {})[method] = item

route("/auth/bootstrap-status", "get", public=True)
route("/auth/bootstrap", "post", request="BootstrapInput", public=True)
route("/auth/login", "post", request="LoginInput", public=True)
route("/auth/logout", "post")
route("/auth/csrf", "get")
route("/me", "get")
route("/openapi.json", "get", public=True)
for health in ["live", "ready"]:
    route(f"/health/{health}", "get", public=True)
for plural, name in [("accounts", "Account"), ("categories", "Category"), ("transactions", "Transaction"), ("budgets", "Budget")]:
    query = ["cursor", "limit"]
    query += {"accounts": ["include_archived"], "categories": ["include_archived", "kind"], "transactions": ["account_id", "account_type", "category_id", "member_id", "event_type", "reconciliation_state", "from", "to", "q", "sort"], "budgets": ["month", "scope"]}[plural]
    route(f"/{plural}", "get", name + "Collection", parameters=query)
    route(f"/{plural}", "post", name, name + "Input")
    route(f"/{plural}/{{id}}", "get", name)
    route(f"/{plural}/{{id}}", "patch", name, name + "Patch", revision=True)
for kind in ["transactions", "budgets"]:
    route(f"/{kind}/{{id}}/revisions", "get")
route("/transactions/{id}/void", "post", "Transaction", "Reason", revision=True)
route("/transactions/{id}", "delete", request="Reason", revision=True)
for action in ["archive", "restore"]:
    route(f"/categories/{{id}}/{action}", "post", "Category", "Revision", revision=True)
route("/accounts/{id}/access/{member_id}", "put", revision=True)
route("/accounts/{id}/statements", "get", parameters=["month"])
route("/accounts/{id}/statement-months", "get")
schemas["DatedBalance"] = obj({"amount":{"type":["string","null"]},"currency":S,"basis":S,"as_of":S,"complete":B,"coverage":S,"source":enum("opening_balance","balance_check","unknown"),"anchor_at":{"type":["string","null"]}}, ("amount","currency","basis","as_of","complete","source"))
schemas["AccountLedgerRow"] = obj({"transaction_id":{"type":["string","null"]},"effective_date":D,"effective_at":S,"description":S,"event_type":S,"movement":{"type":["string","null"]},"observed_amount":M,"check_id":S,"currency":S,"computed_from_start":{"type":["string","null"]},"balance_after":{"type":["string","null"]},"balance_source":S,"anchor_at":{"type":["string","null"]},"same_time_count":I,"same_time_group_movement":M}, ("effective_date","effective_at","movement","currency","computed_from_start","balance_after","balance_source"))
schemas["AccountLedgerCollection"] = obj({"data":arr(ref("AccountLedgerRow")),"page":obj({"next_cursor":S}),"meta":obj({})}, ("data","page","meta"))
route("/money-manager/changes", "get", "TransactionCollection", parameters=["include_done","cursor","limit"])
route("/money-manager/changes/{id}/sync", "post", "Transaction", revision=True)
route("/accounts/{id}/balance-at", "get", "DatedBalance", parameters=["as_of"])
route("/accounts/{id}/ledger", "get", "AccountLedgerCollection", parameters=["from","to","cursor","limit"])
route("/accounts/{id}/balance-checks", "get", parameters=["from","to","cursor","limit"])
route("/accounts/{id}/balance-checks", "post", revision=True)
route("/accounts/{id}/balance-checks/{check_id}", "patch", revision=True)
route("/accounts/{id}/balance-checks/{check_id}", "delete", revision=True)
route("/transfers", "get", "TransactionCollection", parameters=["account_id", "account_type", "from", "to", "cursor", "limit"])
for report in ["summary", "series", "categories", "income-categories", "merchants", "types", "accounts", "transfers", "coverage", "transactions"]:
    route(f"/analytics/{report}", "get", parameters=["scope", "from", "to", "currency", "account_id", "category_id", "member_id", "cursor", "limit", "grain"])
for action in ["activate", "archive", "copy"]:
    route(f"/budgets/{{id}}/{action}", "post", "Budget", revision=True)
route("/budgets/{id}/tracking", "get", parameters=["from", "to"])
route("/settings/household", "get")
route("/settings/household", "patch", revision=True)
route("/households/{household_id}/members", "get")
route("/households/{household_id}/invites", "post", request="InviteInput")
route("/invites/{token}/accept", "post", public=True)
for method in ["patch", "delete"]:
    route("/households/{household_id}/members/{member_id}", method, revision=True)
# Durable source imports and review.
for name in ["ImportBatch", "SourceFile", "ImportJob"]:
    schemas[name] = obj({"id": S, "state": S, "revision": I}, ("id", "state", "revision"))
schemas["ImportManifest"] = obj({"files": arr(obj({"source_kind": enum("money_manager", "bank_statement"), "account_id": S, "mapping": obj({})}, ("source_kind",)))}, ("files",))
schemas["ImportMapping"] = obj({"expected_revision": I, "mapping": obj({"account_id": S, "currency": S, "date_locale": enum("DMY", "MDY"), "account_aliases": obj({}), "category_mappings": arr(obj({"source_label": S, "subcategory": S, "event_kind": enum("expense", "income"), "category_id": S}))})})
route("/imports", "get", parameters=["cursor", "limit"])
route("/imports", "post", "ImportBatch")
schemas["MoneyManagerCleanupInput"] = obj({"period": S, "preview_token": S}, ("period",))
route("/imports/money-manager/cleanup-preview", "post", request="MoneyManagerCleanupInput")
route("/imports/money-manager/cleanup", "post", request="MoneyManagerCleanupInput")
reset_months = {"type":"array", "items":{"type":"string", "pattern":r"^\d{4}-(0[1-9]|1[0-2])$"}, "minItems":1, "maxItems":24}
schemas["MonthResetPreviewInput"] = obj({"months":reset_months}, ("months",))
schemas["MonthResetInput"] = obj({"months":reset_months,"preview_token":S,"confirmation":enum("RESET")}, ("months","preview_token","confirmation"))
schemas["MonthResetResult"] = obj({"months":reset_months,"counts":obj({k:I for k in ["transactions","statement_entries","reconciliation_sessions","balance_checks","budgets","import_rows"]}),"preview_token":S,"scope":S}, ("months","counts","preview_token","scope"))
route("/data/reset-preview", "post", "MonthResetResult", "MonthResetPreviewInput")
route("/data/reset", "post", "MonthResetResult", "MonthResetInput")
paths["/imports"]["post"]["responses"] = {"202": {"description": "Upload accepted and durable parse jobs queued", "content": {"application/json": {"schema": ref("ImportBatch")}}}, "default": paths["/imports"]["post"]["responses"]["default"]}
paths["/imports"]["post"]["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": obj({"manifest": {"type": "string", "contentMediaType": "application/json"}, "files[]": arr({"type": "string", "format": "binary"})}, ("manifest", "files[]"))}}}
for path,method,response,request in [
    ("/imports/{batch_id}", "get", "ImportBatch", None),
    ("/imports/{batch_id}/files/{file_id}", "get", "SourceFile", None),
    ("/imports/{batch_id}/files/{file_id}/mapping", "patch", "SourceFile", "ImportMapping"),
    ("/imports/{batch_id}/preview", "get", None, None),
    ("/imports/{batch_id}/commit", "post", None, "Revision"),
    ("/imports/{batch_id}/files/{file_id}/retry", "post", "SourceFile", "Revision"),
    ("/imports/{batch_id}/files/{file_id}/omit", "post", "SourceFile", "Reason"),
    ("/imports/{batch_id}/cancel", "post", "ImportBatch", "Revision"),
    ("/source-files/{file_id}/download", "get", None, None),
    ("/jobs/{job_id}", "get", "ImportJob", None),
    ("/jobs/{job_id}/events", "get", None, None),
    ("/source-profiles", "get", None, None),
    ("/source-profiles/{id}/category-mappings", "get", None, None),
    ("/source-profiles/{id}/category-mappings/{mapping_id}", "put", None, None),
    ("/source-profiles/{id}/account-aliases/{alias_id}", "put", None, None),
    ("/transfers/review-queue", "get", None, None),
    ("/transfers/review-queue/{item_id}/pair", "post", "Transaction", None),
    ("/transfers/review-queue/{item_id}/reject", "post", None, "Reason"),
]:
    route(path, method, response, request, revision=method in ["patch"] or path.endswith(("/commit","/retry","/omit","/cancel")), parameters=["file_id", "cursor", "limit"] if path.endswith("/preview") else [])
paths["/source-files/{file_id}/download"]["get"]["responses"]["200"]["content"] = {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}
paths["/jobs/{job_id}/events"]["get"]["responses"]["200"]["content"] = {"text/event-stream": {"schema": S}}

# Deterministic reconciliation uses signed allocation amounts in the account currency.
schemas["ReconciliationSessionInput"] = obj({"account_id": S, "month": S, "expected_revision": I, "reason": S}, ("account_id", "month"))
schemas["MatchAllocation"] = obj({"ledger_id": S, "ledger_revision": I, "observation_id": S, "amount": M}, ("ledger_id", "ledger_revision", "observation_id", "amount"))
schemas["MatchInput"] = obj({"expected_revision": I, "decision": enum("accept"), "allocations": arr(ref("MatchAllocation")), "note": S}, ("decision", "allocations"))
schemas["AutoMatchResult"] = obj({"matched_count": I, "session_revision": I}, ("matched_count", "session_revision"))
schemas["AmendmentInput"] = obj({"ledger_id": S, "ledger_revision": I, "observation_id": S, "proposed_amount": M, "reason": S}, ("ledger_id", "ledger_revision", "observation_id", "proposed_amount", "reason"))
schemas["CancelAmendmentInput"] = obj({"amendment_revision": I, "reason": S}, ("amendment_revision", "reason"))
schemas["ReconciliationAmendment"] = obj({"id": S, "session_id": S, "account_id": S, "ledger_id": S, "ledger_revision": I, "applied_transaction_revision": I, "observation_id": S, "currency": S, "original_transaction_amount": M, "original_movement": M, "proposed_movement": M, "proposed_transaction_amount": M, "difference": M, "original_date": D, "proposed_date": D, "description": S, "statement_description": S, "statement_reference": S, "source_refs": arr(obj({})), "reason": S, "status": S, "stale": B, "created_at": S}, ("id", "session_id", "account_id", "ledger_id", "observation_id", "currency", "original_movement", "proposed_movement", "difference", "reason", "status"))
schemas["MissingEntryInput"] = obj({"expected_revision": I, "observation_id": S, "transaction": ref("TransactionInput"), "reason": S}, ("observation_id", "transaction", "reason"))
schemas["ReconciliationSession"] = obj({"id": S, "revision": I, "account_id": S, "month": S, "from": D, "to": D, "currency": S, "state": enum("open", "closed"), "needs_review": B, "stale": B, "coverage": S, "current": obj({}), "closure": obj({})}, ("id", "revision", "account_id", "month", "from", "to", "currency", "state"))
schemas["ReconciliationMatch"] = obj({"id": S, "revision": I, "session_revision": I, "session_id": S, "account_id": S, "state": enum("accepted", "rejected", "needs_review"), "allocations": arr(ref("MatchAllocation")), "note": {"type": ["string", "null"]}}, ("id", "revision", "session_id", "account_id", "state", "allocations"))
schemas["CorrectionInput"] = obj({"expected_revision": I, "mode": enum("preview", "apply"), "ledger_id": S, "ledger_revision": I, "changes": ref("TransactionPatch"), "reason": S, "preview_token": S}, ("mode", "ledger_id", "ledger_revision", "changes"))
schemas["DuplicateMergeInput"] = obj({"expected_revision": I, "survivor_id": S, "discarded_id": S, "survivor_revision": I, "discarded_revision": I, "reason": S, "preview_token": S}, ("survivor_id", "discarded_id", "survivor_revision", "discarded_revision"))
schemas["CloseSessionInput"] = obj({"expected_revision": I, "closing_evidence": obj({}), "reason": S}, ("closing_evidence", "reason"))
schemas["RejectMatchInput"] = obj({"expected_revision": I, "match_revision": I, "reason": S}, ("match_revision", "reason"))
reconciliation_routes = [
    ("/reconciliation/sessions", "get", None, ["account_id", "month", "cursor", "limit"]),
    ("/reconciliation/sessions", "post", "ReconciliationSessionInput", []),
    ("/reconciliation/sessions/{id}", "get", None, []),
    ("/reconciliation/sessions/{id}/items", "get", None, ["side", "state", "cursor", "limit"]),
    ("/reconciliation/sessions/{id}/candidates", "get", None, ["ledger_id", "observation_id", "cursor", "limit"]),
    ("/reconciliation/sessions/{id}/matches", "post", "MatchInput", []),
    ("/reconciliation/sessions/{id}/auto-match", "post", None, []),
    ("/reconciliation/sessions/{id}/internal-transfer-candidates", "get", None, ["observation_id", "cursor", "limit"]),
    ("/reconciliation/sessions/{id}/internal-transfer", "post", None, []),
    ("/reconciliation/sessions/{id}/ignored", "post", None, []),
    ("/reconciliation/sessions/{id}/ignored/{ignore_id}/restore", "post", None, []),
    ("/reconciliation/sessions/{id}/created-ledger-entries", "get", None, ["cursor", "limit"]),
    ("/reconciliation/sessions/{id}/created-ledger-entries", "post", None, []),
    ("/reconciliation/sessions/{id}/amendments/batch", "post", None, []),
    ("/reconciliation/sessions/{id}/amendments", "get", None, ["cursor", "limit"]),
    ("/reconciliation/sessions/{id}/amendments", "post", "AmendmentInput", []),
    ("/reconciliation/sessions/{id}/amendments/{amendment_id}/cancel", "post", "CancelAmendmentInput", []),
    ("/reconciliation/sessions/{id}/matches/{match_id}/reject", "post", "RejectMatchInput", []),
    ("/reconciliation/sessions/{id}/missing-ledger-entry", "post", "MissingEntryInput", []),
    ("/reconciliation/sessions/{id}/close", "post", "CloseSessionInput", []),
    ("/reconciliation/sessions/{id}/matches", "get", None, ["cursor", "limit"]),
    ("/reconciliation/sessions/{id}/corrections", "post", "CorrectionInput", []),
    ("/reconciliation/sessions/{id}/duplicates", "get", None, ["cursor", "limit"]),
    ("/reconciliation/sessions/{id}/duplicates/{candidate_id}/merge-preview", "post", "DuplicateMergeInput", []),
    ("/reconciliation/sessions/{id}/duplicates/{candidate_id}/merge", "post", "DuplicateMergeInput", []),
    ("/reconciliation/sessions/{id}/reopen", "post", "Reason", []),
]
for path, method, request, params in reconciliation_routes:
    response = None
    if path == "/reconciliation/sessions/{id}" or path.endswith(("/close", "/reopen")) or path == "/reconciliation/sessions" and method == "post":
        response = "ReconciliationSession"
    if method == "post" and (path.endswith("/matches") or path.endswith("/reject")):
        response = "ReconciliationMatch"
    if path.endswith("/auto-match"):
        response = "AutoMatchResult"
    if path.endswith("/amendments") and method == "post":
        response = "ReconciliationAmendment"
    if path.endswith("/amendments/{amendment_id}/cancel"):
        response = "ReconciliationAmendment"
    route(path, method, response=response, request=request, revision=method == "post", parameters=params)
paths["/reconciliation/sessions"]["post"]["responses"]["201"] = {"description": "Created account/month session", "content": {"application/json": {"schema": ref("ReconciliationSession")}}}

# Register the remaining contract surface explicitly; it must not simulate success.
deferred = {
    "/categories/{id}/merge-preview": ["post"], "/categories/{id}/merge": ["post"],
    
    "/reconciliation/sessions": ["get", "post"],
    "/reconciliation/sessions/{id}/items": ["get"], "/reconciliation/sessions/{id}/candidates": ["get"],
    "/reconciliation/sessions/{id}/matches": ["post"], "/reconciliation/sessions/{id}/matches/{match_id}/reject": ["post"],
    "/reconciliation/sessions/{id}/auto-match": ["post"],
    "/reconciliation/sessions/{id}/amendments": ["get", "post"],
    "/reconciliation/sessions/{id}/amendments/{amendment_id}/cancel": ["post"],
    "/reconciliation/sessions/{id}/missing-ledger-entry": ["post"], "/reconciliation/sessions/{id}/corrections": ["post"],
    "/reconciliation/sessions/{id}/duplicates": ["get"], "/reconciliation/sessions/{id}/duplicates/{candidate_id}/merge-preview": ["post"],
    "/reconciliation/sessions/{id}/duplicates/{candidate_id}/merge": ["post"], "/reconciliation/sessions/{id}/close": ["post"], "/reconciliation/sessions/{id}/reopen": ["post"],
    "/analytics/exports": ["post"], "/budgets/{id}/contribution-targets/{member_id}": ["put"], "/budgets/{id}/contribution-links": ["post"],
    "/budget-alerts": ["get"], "/budget-alerts/{id}/acknowledge": ["post"],
    "/settings/ai": ["get"], "/settings/ai/providers/{provider_id}": ["put", "delete"], "/settings/ai/providers/{provider_id}/key": ["put", "delete"],
    "/settings/ai/providers/{provider_id}/test": ["post"], "/settings/ai/tasks/{task}": ["put"], "/settings/ai/usage": ["get"],
    "/operations/backup": ["post"], "/operations/backups": ["get"], "/operations/backups/{id}/restore": ["post"],
}
for path, methods in deferred.items():
    for method in methods:
        if path not in paths or method not in paths[path]:
            route(path, method, implemented=False)

document = {"openapi": "3.1.0", "info": {"title": "FinWise API", "version": "0.1.0", "description": "Core implementation. Check x-implemented for each operation. Deferred workflows return 501; unknown routes return 404."}, "servers": [{"url": "/api/v1"}], "paths": paths, "components": {"securitySchemes": {"session": {"type": "apiKey", "in": "cookie", "name": "finwise_session"}}, "schemas": schemas}}

# Structural validation of generated references, operation IDs and path parameters.
def validate_contract(document):
    operations = set()
    def refs(value):
        if isinstance(value, dict):
            if "$ref" in value:
                target = document
                for part in value["$ref"].removeprefix("#/").split("/"):
                    target = target[part]
            for child in value.values():
                refs(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                refs(child)
    refs(document)
    for path, methods in document["paths"].items():
        expected = {p[1:-1] for p in path.split("/") if p.startswith("{")}
        for operation in methods.values():
            assert operation["operationId"] not in operations, "Duplicate operation ID"
            operations.add(operation["operationId"])
            params = {p["name"] for p in operation["parameters"] if p["in"] == "path" and p.get("required")}
            assert expected == params, f"Path parameters do not match {path}"
            assert operation["responses"], f"Missing response contract: {path}"
validate_contract(document)

def ts(schema):
    if "$ref" in schema:
        return schema["$ref"].split("/")[-1]
    if "enum" in schema:
        return " | ".join(json.dumps(s) for s in schema["enum"])
    kind = schema.get("type")
    if isinstance(kind, list):
        return " | ".join(ts({"type": k}) for k in kind)
    if kind == "array":
        return "Array<" + ts(schema["items"]) + ">"
    if kind == "object":
        if not schema.get("properties"):
            return "Record<string, unknown>"
        return "{ " + "; ".join(f'{json.dumps(k)}{"" if k in schema.get("required", []) else "?"}: {ts(v)}' for k, v in schema["properties"].items()) + " }"
    return {"integer": "number", "number": "number", "boolean": "boolean", "string": "string", "null": "null"}.get(kind, "unknown")

types = "// Generated by scripts/generate_contract.py; do not edit.\n" + "\n".join(f"export type {name} = {ts(schema)};" for name, schema in schemas.items()) + "\n"
outputs = {ROOT / "backend/openapi.json": json.dumps(document, indent=2) + "\n", ROOT / "web/src/lib/api/types.ts": types}
for path, content in outputs.items():
    if "--check" in sys.argv:
        if not path.exists() or path.read_text() != content:
            raise SystemExit(f"Generated contract drift: {path}")
    else:
        path.write_text(content)
