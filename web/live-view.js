/* Patch an existing view without replacing controls, scroll containers or unrelated rows. */
(() => {
  const pendingPatches = new WeakMap();
  function key(node) {
    if (node.nodeType !== 1) return '';
    if (node.id) return `${node.tagName}#${node.id}`;
    if (node.dataset.liveKey) return `${node.tagName}:${node.dataset.liveKey}`;
    if (node.dataset.reviewType) return `review-type:${node.dataset.reviewType}`;
    if (node.tagName === 'TR') {
      const review = node.querySelector('[data-review-type]');
      if (review) return `review-row:${review.dataset.reviewType}`;
    }
    if (node.dataset.action) return `${node.tagName}:${node.dataset.action}:${node.dataset.id || node.dataset.sort || node.dataset.scope || ''}`;
    return '';
  }
  const compatible = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
  function destroyCharts(node) {
    if (node.nodeType !== 1) return;
    if (node.matches('canvas')) window.Chart?.getChart(node)?.destroy();
    node.querySelectorAll('canvas').forEach(canvas => window.Chart?.getChart(canvas)?.destroy());
  }
  function sync(current, next, active) {
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    // An expanded bulk-selection panel owns its asynchronously loaded content.
    if (current.hasAttribute('data-live-preserve') && current.dataset.loaded === 'true') return;
    const control = current.matches('input,select,textarea');
    const preserveValue = control && (current === active || current.hasAttribute('data-review-type'));
    const value = preserveValue ? current.value : next.value;
    const checked = preserveValue ? current.checked : next.checked;
    const open = current.open;
    const busy = current.matches('button[data-action]') && current.disabled;
    const selection = current === active && typeof current.selectionStart === 'number' ? [current.selectionStart, current.selectionEnd] : null;
    for (const attribute of [...current.attributes]) {
      if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
      if (current.tagName === 'CANVAS' && ['style','width','height'].includes(attribute.name)) continue;
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of next.attributes) {
      if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    if (current.tagName !== 'CANVAS') children(current, next, active);
    if (control) {
      if (current.value !== value) current.value = value;
      if (current.matches('input')) current.checked = checked;
      if (selection) current.setSelectionRange(...selection);
    }
    if (current.tagName === 'DETAILS') current.open = open;
    if (busy) current.disabled = true;
  }
  function children(current, next, active) {
    const existing = [...current.childNodes];
    const keyed = new Map(existing.filter(node => key(node)).map(node => [key(node), node]));
    const used = new Set();
    let cursor = current.firstChild;
    for (const desired of [...next.childNodes]) {
      const desiredKey = key(desired);
      let match = desiredKey ? keyed.get(desiredKey) : null;
      if (!desiredKey) {
        match = cursor && !used.has(cursor) && compatible(cursor, desired) ? cursor
          : existing.find(node => !used.has(node) && !key(node) && compatible(node, desired));
      }
      if (match && !compatible(match, desired)) match = null;
      if (match) {
        used.add(match);
        if (match !== cursor) current.insertBefore(match, cursor);
        sync(match, desired, active);
      } else {
        match = desired.cloneNode(true);
        current.insertBefore(match, cursor);
      }
      cursor = match.nextSibling;
    }
    for (const node of existing) if (!used.has(node)) {
      destroyCharts(node);
      node.remove();
    }
  }
  function patch(root, html) {
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = html;
    const active = root.ownerDocument.activeElement;
    const reviewFocus = active?.closest('#smart-review');
    const scroll = {left: window.scrollX, top: window.scrollY};
    // Prevent browser scroll anchoring from following a review row as it moves up.
    const pending = pendingPatches.get(root);
    if (pending) cancelAnimationFrame(pending.frame);
    const anchor = pending ? pending.anchor : root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    const containers = [...root.querySelectorAll('.table-scroll')].map(node => [node, node.scrollLeft, node.scrollTop]);
    children(root, template.content, active);
    for (const [node, left, top] of containers) if (node.isConnected) {
      node.scrollLeft = left; node.scrollTop = top;
    }
    if (reviewFocus && !active.isConnected) {
      const next = root.querySelector('#smart-review [data-action="classification-confirm"]') || root.querySelector('#smart-review h2');
      if (next) {if (next.tagName === 'H2') next.tabIndex = -1; next.focus({preventScroll: true});}
    }
    window.scrollTo({...scroll, behavior: 'instant'});
    const firstChild = root.firstChild;
    const update = {anchor, frame: requestAnimationFrame(() => {
      if (root.isConnected && root.firstChild === firstChild) window.scrollTo({...scroll, behavior: 'instant'});
      root.style.overflowAnchor = anchor;
      pendingPatches.delete(root);
    })};
    pendingPatches.set(root, update);
  }
  window.finwiseLiveView = {patch};
})();
