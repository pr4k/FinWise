const form = document.querySelector('#upload-form');
const fileInput = document.querySelector('#file-input');
const dropzone = document.querySelector('#dropzone');
const fileLabel = document.querySelector('#file-label');
const backend = document.querySelector('#backend');
const modelSelect = document.querySelector('#model');
const modelStatus = document.querySelector('#model-status');
const categoryStatus = document.querySelector('#category-status');
const categoryList = document.querySelector('#category-list');
const downloadModelButton = document.querySelector('#download-model');
const runButton = document.querySelector('#run-button');
const errorBox = document.querySelector('#error');
const results = document.querySelector('#results');
const tableBody = document.querySelector('#result-body');
let responseData = null;
let activeFilter = 'all';
let serviceStatus = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setFile(file) {
  if (!file) return;
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['csv', 'xlsx'].includes(extension)) { showError('Choose a CSV or XLSX file.'); return; }
  if (file.size > 10 * 1024 * 1024) { showError('The file must be 10 MB or smaller.'); return; }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileLabel.textContent = file.name;
  showError('');
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
dropzone.addEventListener('drop', event => setFile(event.dataTransfer.files[0]));

function selectedModelInfo() {
  return serviceStatus?.models.find(model => model.name === modelSelect.value);
}

function updateModelState() {
  if (!serviceStatus?.ollama_ready) {
    backend.value = 'mock';
    modelStatus.textContent = 'Local Ollama is unavailable. Start the native or Docker model service first.';
    modelStatus.className = 'model-status offline';
    downloadModelButton.hidden = true;
    return;
  }
  const selected = selectedModelInfo();
  if (selected?.installed) {
    modelStatus.textContent = `${selected.name} is installed on local Ollama.`;
    modelStatus.className = 'model-status ready';
    downloadModelButton.hidden = true;
  } else {
    modelStatus.textContent = `${modelSelect.value} is not installed yet. Download it to classify with this model.`;
    modelStatus.className = 'model-status offline';
    downloadModelButton.hidden = !selected?.downloadable;
  }
}

async function refreshStatus(firstLoad = false) {
  const response = await fetch('/api/status');
  serviceStatus = await response.json();
  categoryStatus.textContent = serviceStatus.category_count
    ? `${serviceStatus.category_count} FinWise categories loaded from the local snapshot.`
    : 'No FinWise categories loaded. Run sync-categories before testing category classification.';
  categoryStatus.className = `model-status ${serviceStatus.category_count ? 'ready' : 'offline'}`;
  categoryList.replaceChildren();
  for (const category of serviceStatus.categories || []) {
    const row = document.createElement('div');
    row.textContent = `${category.kind} · ${category.label} · ${category.id}`;
    categoryList.append(row);
  }
  const previous = modelSelect.value;
  modelSelect.replaceChildren();
  for (const model of serviceStatus.models) {
    const option = document.createElement('option');
    option.value = model.name;
    option.textContent = `${model.name}${model.size ? ` · ${model.size}` : ''}${model.installed ? ' · installed' : ''}`;
    modelSelect.append(option);
  }
  if (firstLoad) {
    const preferred = serviceStatus.models.find(model => model.name === serviceStatus.default_model && model.installed);
    const firstInstalled = serviceStatus.models.find(model => model.installed);
    modelSelect.value = (preferred || firstInstalled)?.name || serviceStatus.default_model;
  } else if (serviceStatus.models.some(model => model.name === previous)) {
    modelSelect.value = previous;
  }
  updateModelState();
}

refreshStatus(true).catch(() => { modelStatus.textContent = 'Could not check local Ollama status.'; });
modelSelect.addEventListener('change', updateModelState);

downloadModelButton.addEventListener('click', async () => {
  showError('');
  downloadModelButton.disabled = true;
  modelSelect.disabled = true;
  downloadModelButton.textContent = `Downloading ${modelSelect.value}…`;
  try {
    const response = await fetch(`/api/pull-model?model=${encodeURIComponent(modelSelect.value)}`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Model download failed.');
    backend.value = 'ollama';
    await refreshStatus();
  } catch (error) { showError(error.message || 'Model download failed.'); }
  finally { downloadModelButton.disabled = false; modelSelect.disabled = false; downloadModelButton.textContent = 'Download selected model'; }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  const file = fileInput.files[0];
  if (!file) { showError('Choose a statement file first.'); return; }
  if (backend.value === 'ollama' && !selectedModelInfo()?.installed) {
    showError('Download the selected model before classifying.');
    return;
  }
  const params = new URLSearchParams({ filename: file.name, backend: backend.value, model: modelSelect.value });
  const selfName = document.querySelector('#self-name').value.trim();
  const limit = document.querySelector('#limit').value.trim();
  if (selfName) params.set('self_name', selfName);
  if (limit) params.set('limit', limit);
  runButton.disabled = true;
  runButton.querySelector('span').textContent = 'Classifying… this may take a few minutes';
  try {
    const response = await fetch(`/api/classify?${params}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Classification failed.');
    responseData = data;
    activeFilter = 'all';
    document.querySelector('#search').value = '';
    updateResults();
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showError(error.message || 'Classification failed.'); }
  finally { runButton.disabled = false; runButton.querySelector('span').textContent = 'Classify statement'; }
});

function updateResults() {
  const rows = responseData.classified;
  const review = responseData.review;
  const categorized = rows.filter(row => row.category_id !== 'unknown').length;
  document.querySelector('#metric-rows').textContent = rows.length;
  document.querySelector('#metric-categories').textContent = rows.length ? `${Math.round(categorized / rows.length * 100)}%` : '0%';
  document.querySelector('#metric-review').textContent = review.length;
  document.querySelector('#metric-self').textContent = rows.filter(row => row.transaction_type === 'self_transfer').length;
  document.querySelector('#all-count').textContent = rows.length;
  document.querySelector('#review-count').textContent = review.length;
  document.querySelector('#result-subtitle').textContent = `${rows.length} transaction${rows.length === 1 ? '' : 's'} processed locally with ${responseData.model}`;
  document.querySelector('#report-text').textContent = responseData.report;
  renderTable();
}

function cell(row, key, className = '') {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = row[key] || '—';
  return td;
}

function badge(value, className = '') {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = `tag ${className}`;
  span.textContent = value.replaceAll('_', ' ');
  td.append(span);
  return td;
}

function renderTable() {
  if (!responseData) return;
  const query = document.querySelector('#search').value.trim().toLowerCase();
  const filtered = responseData.classified.filter(row =>
    (activeFilter === 'all' || row.review_status === 'review') &&
    (!query || ['Description', 'counterparty', 'category', 'vendor_type', 'transaction_type'].some(key => (row[key] || '').toLowerCase().includes(query)))
  );
  tableBody.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const row of filtered) {
    const tr = document.createElement('tr');
    tr.append(cell(row, 'row_number'), cell(row, 'Description', 'description'), cell(row, 'counterparty', 'counterparty'));
    tr.append(badge(row.category || 'unknown', row.category_id === 'unknown' ? 'unknown' : ''));
    tr.append(badge(row.vendor_type, row.vendor_type === 'unknown' ? 'unknown' : ''));
    tr.append(badge(row.transaction_type, row.transaction_type === 'self_transfer' ? 'self' : row.transaction_type === 'unknown' ? 'unknown' : ''));
    tr.append(cell(row, 'confidence'));
    tr.append(badge(row.review_status, row.review_status === 'review' ? 'review' : ''));
    fragment.append(tr);
  }
  tableBody.append(fragment);
  document.querySelector('#table-footer').textContent = `Showing ${filtered.length} of ${responseData.classified.length} rows`;
}

document.querySelector('#search').addEventListener('input', renderTable);
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  activeFilter = tab.dataset.filter;
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  renderTable();
}));

function download(content, filename) {
  if (!responseData) return;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.querySelector('#download-classified').addEventListener('click', () => download(responseData.classified_csv, 'classified.csv'));
document.querySelector('#download-review').addEventListener('click', () => download(responseData.review_csv, 'review.csv'));
