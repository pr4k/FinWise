# Independent app mode

FinWise supports two household-wide operating modes under **Settings → Money Manager integration**. `money_manager_extension` is `true` for new households and is treated as `true` when absent from an older household document. Owners and admins can change it with the revision-checked `PATCH /settings/household` endpoint. The change is audited and reversible. It changes workflow, not account visibility, ledger arithmetic, or import parsing.

| Capability | Extension mode | Independent mode |
| --- | --- | --- |
| Money Manager XLSX import | Available | Available as a normal transaction source |
| Bank statement import and reconciliation | Available | Available |
| Manual transactions and statement-created entries | Included in Money Manager changes | FinWise records only; marked `money_manager_excluded` |
| Reconciliation amendments | Reason requested; pending Money Manager update | No reason prompt; server records `Adjusted to statement`; status `applied` |
| Money Manager change list, sync endpoint, and amendment exports | Available | Hidden in UI; changes API returns 404 |
| Previous Money Manager change records | Retained | Hidden until extension mode is restored |

The mode belongs to the household because reconciliation sessions, transaction history, and the external change queue are household resources. The web client reads it from `/me` and suppresses Money Manager navigation, badges, update copy, exports, and the amendment reason field in independent mode. The server gates the changes API so a stale browser cannot continue syncing changes after the toggle is saved.

`money_manager_excluded` is set on manual transactions created while independent, on transactions edited while independent, and on statement-created, converted, or amended transactions in that mode. It prevents those operations from appearing as new external work if extension mode is later restored. Imported workbook source references, raw import rows, and reconciliation evidence remain intact. Existing pending changes from the earlier extension period remain stored and reappear when that mode is restored. Imported transactions can still be edited and reconciled in FinWise.

No database migration is needed: household settings and transactions are JSON documents. The OpenAPI schema and generated browser types include the new fields. Mode changes require household admin access and the current household revision; members can read the mode through `/me` and Settings. The ordinary import pipeline and source deduplication rules apply in both modes.
