# AI service: local bank statement prototype

This Python CLI is independent of the FinWise backend. A one-time, read-only export copies active FinWise category IDs, names, kinds and hierarchy from local SQLite into `ai-service/categories.json`. Classification never calls the FinWise service or database. It connects only to local Ollama (`127.0.0.1:11434` for the Docker service, `127.0.0.1:11435` for native macOS, or the private Compose service name); the `mock` backend needs no model and is useful for testing. The source CSV is opened read-only and is never overwritten.

## Plan and design

1. Read the statement columns as text, retaining the original values in the classified CSV.
2. Extract a counterparty candidate from known narration shapes. A name is a candidate, not evidence of a business type.
3. Detect transaction purpose separately, including self transfers when the account owner's name is explicitly supplied.
4. Check confirmed vendors in a local JSON mapping, then use a few explicit service cues. Ask Ollama for schema-constrained JSON on unfamiliar rows, then validate types, confidence, and literal evidence in Python.
5. Propose a FinWise category separately, using only active category IDs of the right income or expense kind. Self transfers remain uncategorized. CheQ can map to **Credit card settlement**, but it cannot reveal the purchases behind the bill.
6. Send unknown or low-confidence rows to `review.csv`. The reviewer fills `decision` with `approve` or `correct`, supplies corrections where needed, then imports confirmed vendor types and category choices into the mapping.
7. Write `classified.csv` and a short `report.txt`. The report uses only row numbers and narration hashes for unresolved examples; it does not include full descriptions.

CheQ is a payment service, never the underlying card merchant. `EQ Trade` supports an investment transaction type but does not identify a vendor. A bank name, payment handle, transaction ID, or person's name alone does not identify a vendor type. Self transfers are counted separately from purchases.

## Local upload page

Start the standalone page without Docker:

```sh
python3 ai-service/web_server.py
```

Open `http://127.0.0.1:8765`. Upload a `.csv` or `.xlsx` statement (up to 10 MB), choose local Ollama or the mock preview, and see FinWise category coverage, review count, and row classifications. The page can download classified and review CSVs. Excel import reads the first worksheet and finds the required `Description`, `Debit`, and `Credit` headers within its first 25 nonempty rows. `.xls` is not supported. Uploads and intermediate outputs are temporary; the source file is not changed. Confirmed mappings remain in the local JSON file.

## FinWise categories

The current local FinWise database has **43 active categories**. Their IDs and parent paths are stored in the private, Git-ignored `ai-service/categories.json` snapshot. To refresh it after editing categories in FinWise:

```sh
python3 ai-service/ai_service.py sync-categories --finwise-db data/finwise.sqlite
```

The command opens SQLite read-only, copies only active category metadata, and closes it. The AI service then uses the snapshot; it does not connect to the main service at runtime. For another database, pass its path with `--finwise-db`. If that database has multiple households, also pass `--household-id`.

The upload page lists the categories and their IDs under **View available FinWise categories**. The `classified.csv` adds `category_id`, hierarchical `category`, `category_confidence`, `category_evidence` and `category_source`. Unknown categories use `unknown`. In `review.csv`, enter an exact ID from the page or `categories.json` in `approved_category_id` to correct or confirm a category. Imported reviews save row choices and a default category for confirmed counterparties. A merchant may sell different things, so review a default category before relying on it for later transactions. The snapshot and mappings stay on this machine. Docker Compose mounts the snapshot read-only; refresh it before starting Compose to see recent FinWise edits.

Choose a model from the **Model** field before classifying. The page lists all locally installed Ollama models and offers `qwen2.5:0.5b`, `qwen2.5:1.5b`, and `qwen2.5:3b` as downloadable choices. For a missing Qwen model, click **Download selected model**; Ollama downloads model files from its library, with no statement attached. You can switch between installed models for each upload without restarting the page. Cloud models are excluded.

## Setup and run

Requires Python 3.10+ and no Python packages.

### Native macOS GPU (Apple Silicon)

From the repository root, run:

```sh
bash ai-service/run-local-gpu.sh --install
```

`--install` installs the native Ollama CLI with Homebrew if it is missing. Omit `--install` on later runs. The script starts Ollama with cloud features disabled on `127.0.0.1:11435`, pulls `qwen2.5:3b` into the native Ollama model store if needed, prints `ollama ps` so you can verify `GPU`, and starts the upload page at `http://127.0.0.1:8766`. Keep the terminal open; Ctrl-C stops both processes. It uses separate ports so an existing Docker AI service can remain running. The native model is stored separately from Docker's model volume and may need its own download.

The page can now switch models without restarting. To preload a smaller model when starting the native launcher, run:

```sh
bash ai-service/run-local-gpu.sh qwen2.5:1.5b
```

The page displays the selected model. `qwen2.5:1.5b` is about 986 MB versus about 1.9 GB for `qwen2.5:3b`. The launcher also accepts `qwen2.5:0.5b` (about 398 MB), but expect more abstentions or classification mistakes from such a small model. Review its output before saving mappings. Each model is downloaded once into the native Ollama store.

For the CLI instead of the page, set `AI_SERVICE_OLLAMA_URL=http://127.0.0.1:11435` and use the usual `classify --backend ollama` command while this script is running.

### Docker CPU service

To run the model as an independent Docker Compose service, start Docker Desktop (or another Docker daemon) and run from the repository root:

```sh
sh ai-service/setup-ollama.sh
docker compose -f ai-service/compose.yaml ps
curl --fail http://127.0.0.1:11434/api/tags
```

The setup script starts only `ai-service/compose.yaml`, pulls `qwen2.5:3b` into a persistent Docker volume, then starts the separate upload page at `http://127.0.0.1:8765`. The model is about 1.9 GB. Docker publishes both services only on host loopback, and `OLLAMA_NO_CLOUD=1` disables Ollama cloud features. Statement data goes only to the private Compose Ollama service. On macOS, Docker Desktop cannot pass the Apple GPU to the Linux container, so inference runs on CPU; the native Ollama app is an optional faster alternative if desired.

Then classify:

```sh
python3 ai-service/ai_service.py classify \
  --input '/absolute/path/to/statement.csv' \
  --output-dir ai-service/output \
  --backend ollama --model qwen2.5:3b \
  --self-name 'YOUR EXACT NAME'
```

Stop the page and model with `docker compose -f ai-service/compose.yaml down`. This leaves the model and mapping volumes intact. The Compose project is separate from `deploy/compose.yaml` and does not start the FinWise application.

Without Ollama, exercise the same pipeline with deterministic, conservative proposals:

```sh
python3 ai-service/ai_service.py classify \
  --input '/absolute/path/to/statement.csv' \
  --output-dir ai-service/output --backend mock --limit 60 \
  --self-name 'YOUR EXACT NAME'
python3 -m unittest discover -s ai-service -p 'test_*.py'
```

Edit `ai-service/output/review.csv` locally. Set `decision` to `approve` for an accepted proposal or `correct` and fill `approved_vendor_type` (and, if needed, `corrected_counterparty`, `approved_transaction_type` and `approved_category_id`). Keep `row_key` unchanged; it connects the decision to the original row. Then run:

```sh
python3 ai-service/ai_service.py apply-review --review ai-service/output/review.csv
python3 ai-service/ai_service.py classify --input '/absolute/path/to/statement.csv' --output-dir ai-service/output --backend ollama
```

The mapping and default output directory are ignored by Git because they contain private statement-derived data. Keep any custom output directory and mapping outside version control. Transaction types can vary by vendor, so the mapping stores confirmed vendor types by counterparty and transaction corrections by row hash. Rerun classification after review to apply both.

## Current limits

Counterparty extraction is intentionally narrow and may miss unfamiliar bank formats. Model proposals are suggestions, and the user should review uncertain rows. The mock backend recognizes only explicit service cues and cannot validate how a real local model performs. No model fine tuning is involved.
