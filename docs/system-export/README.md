# FinWise system export

Snapshot prepared 23 October 2026 from the repository. This folder is a reviewable, schema-only and contract-only export; it contains no household database or uploaded financial files.

| File | Contents | Authority |
| --- | --- | --- |
| [db-schema.sql](db-schema.sql) | Executable DDL for an **empty** SQLite database | Snapshot of `backend/migrations/0001_core.sql`–`0012_budget_commitment_matches.sql` |
| [db-schema-export.md](db-schema-export.md) | All tables, columns, foreign keys, indexes, and storage conventions | Derived from the migrated SQLite schema |
| [openapi.json](openapi.json) | Full machine-readable OpenAPI 3.1 contract | Snapshot of `backend/openapi.json` |
| [api-spec-export.md](api-spec-export.md) | Calling conventions and every API operation with implementation status | Derived from `openapi.json` |
| [overview-and-architecture.md](overview-and-architecture.md) | Current system, flows, decisions, UI ideas, and future design | Code and product specs, with status separated |

The committed migrations and `scripts/generate_contract.py` remain the source of truth. The running server also serves its contract at `/api/v1/openapi.json`. These exported files should be refreshed when migrations or the generated API change. Do not apply `db-schema.sql` over a populated FinWise database; it is a clean-install structural snapshot, not an upgrade or data backup.

The household budgeting [feature specification](../FinWise_Household_Budgeting_Feature_Spec.md) and [implementation plan](../household-budgeting-implementation-plan.md) describe a broader target. The investment [product specification](../FinWise_Investment_Module_Product_Spec.md) also proposes more than the present investment resource model. The architecture document identifies those differences.
