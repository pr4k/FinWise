/* Same-origin cookies stay HttpOnly. CSRF and retry keys are held in memory only. */
(() => {
  let csrf = '';
  const pending = new Map();
  const reads = new Map();
  const cacheLifetime = 10000;
  function requestKey() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  async function request(path, { method = 'GET', body, revision, key, signal } = {}) {
    // Only computed reports are reused. Activity, membership and account lists
    // must reflect another household member's changes on the next navigation.
    const cacheable=method==='GET' && !signal && /^analytics\/(summary|series|categories|income-categories|merchants|types|accounts)(\?|$)/.test(path);
    if (cacheable) {
      const saved=reads.get(path);
      if (saved && saved.expires>Date.now()) return saved.value;
      if (saved?.promise) return saved.promise;
      const promise=fetchRequest(path,{method,body,revision,key,signal});
      reads.set(path,{promise});
      try {
        const value=await promise;
        if (reads.get(path)?.promise===promise) {
          reads.delete(path);
          reads.set(path,{value,expires:Date.now()+cacheLifetime});
          if (reads.size>100) reads.delete(reads.keys().next().value);
        }
        return value;
      } catch(error) { if(reads.get(path)?.promise===promise) reads.delete(path); throw error; }
    }
    const value=await fetchRequest(path,{method,body,revision,key,signal});
    if (method !== 'GET') reads.clear();
    return value;
  }
  async function fetchRequest(path, { method, body, revision, key, signal }) {
    const multipart = body instanceof FormData;
    const signature = `${method}:${path}:${revision ?? ''}:${multipart ? [...body].map(([k,v]) => `${k}:${v instanceof File ? `${v.name}:${v.size}:${v.lastModified}` : v}`).join('|') : JSON.stringify(body)}`;
    const headers = {};
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
    if (revision !== undefined) headers['If-Match'] = String(revision);
    if (method === 'POST' && !['auth/login','auth/logout'].includes(path)) {
      if (!pending.has(signature)) pending.set(signature, key || requestKey());
      headers['Idempotency-Key'] = pending.get(signature);
    }
    const response = await fetch(`/api/v1/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', headers, signal,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      // On definitive validation errors a changed request needs a fresh key.
      if (response.status < 500) pending.delete(signature);
      if (response.status === 401 && !path.startsWith('auth/')) window.dispatchEvent(new Event('session-expired'));
      const error = new Error(value?.error?.message || `Request failed (${response.status}).`);
      error.status = response.status; error.code = value?.error?.code;
      throw error;
    }
    pending.delete(signature);
    return value;
  }
  async function collection(path) {
    const data = []; let cursor; let meta;
    do {
      const query = `${path}${path.includes('?') ? '&' : '?'}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await request(query);
      data.push(...page.data); meta = page.meta; cursor = page.page?.next_cursor;
    } while (cursor);
    return { data, meta };
  }
  window.finwiseAPI = { request, collection, setCsrf(value) { if(csrf!==value) reads.clear(); csrf = value; }, reset() { csrf = ''; pending.clear(); reads.clear(); } };
})();
