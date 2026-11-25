/* A read-only, client-side exploration of the transactions visible to this user. */
(() => {
  const columns=[['date','Date'],['description','Description'],['type','Type'],['category','Category'],['account','Account'],['scope','Scope'],['amount','Amount'],['currency','Currency']];
  let rows=[], sort='date', direction=-1, page=0;
  const filterKeys=['type','category','account','scope','currency'];
  const filters={search:'',type:[],category:[],account:[],scope:[],currency:[],from:'',to:''};
  const widths={date:125,description:220,type:140,category:180,account:180,scope:120,amount:140,currency:110};
  let freezeThrough='', selection=null, pageRows=[];
  const visible=new Set(columns.map(([key])=>key));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function unique(values) { return [...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
  function selectedRows() {
    const query=filters.search.trim().toLocaleLowerCase();
    return rows.filter(row=>(!query||columns.some(([key])=>String(row[key]).toLocaleLowerCase().includes(query))) &&
      filterKeys.every(key=>!filters[key].length||filters[key].some(value=>row.parts[key].includes(value))) &&
      (!filters.from||row.date>=filters.from)&&(!filters.to||row.date<=filters.to))
      .sort((a,b)=>direction*(sort==='amount'?Number(a.amount)-Number(b.amount):String(a[sort]).localeCompare(String(b[sort]),undefined,{numeric:true,sensitivity:'base'})) || a.index-b.index);
  }
  function applyWidths(host) {
    const active=columns.filter(([key])=>visible.has(key));
    const freezeIndex=active.findIndex(([key])=>key===freezeThrough);
    let left=48;
    const table=host.querySelector('.sheet-table');
    table.style.width=(48+active.reduce((sum,[key])=>sum+widths[key],0)+90)+'px';
    table.querySelectorAll('[data-sheet-cell]').forEach(cell=>{
      const key=cell.dataset.sheetCell;
      cell.style.width=widths[key]+'px';
    });
    table.querySelectorAll('.sheet-row-number').forEach(cell=>{
      cell.classList.toggle('sheet-frozen',freezeIndex>=0);cell.style.left=freezeIndex>=0?'0px':'';
    });
    active.forEach(([key],index)=>{
      table.querySelectorAll(`[data-sheet-cell="${key}"]`).forEach(cell=>{
        cell.classList.toggle('sheet-frozen',index<=freezeIndex);
        cell.classList.toggle('sheet-frozen-edge',index===freezeIndex && freezeIndex>=0);
        cell.style.left=index<=freezeIndex?left+'px':'';
      });
      left+=widths[key];
    });
  }
  function updateSelection(host) {
    const panel=host.querySelector('[data-sheet-summary]');
    host.querySelectorAll('tbody td[data-sheet-cell]').forEach(cell=>{
      const selected=!!selection && cell.dataset.sheetCell===selection.column && Number(cell.dataset.sheetRow)>=Math.min(selection.start,selection.end) && Number(cell.dataset.sheetRow)<=Math.max(selection.start,selection.end);
      cell.classList.toggle('sheet-selected',selected);
      cell.setAttribute('aria-selected',String(selected));
    });
    panel.hidden=!selection;
    if(!selection){panel.replaceChildren();return;}
    const chosen=pageRows.slice(Math.min(selection.start,selection.end),Math.max(selection.start,selection.end)+1);
    const label=columns.find(([key])=>key===selection.column)?.[1]||'';
    let details='';
    if(selection.column==='amount') {
      const groups=new Map();
      for(const row of chosen) {
        const value=String(row.amount).trim();
        if(!/^-?\d+(?:\.\d+)?$/.test(value))continue;
        const currency=row.currency||'Unknown currency';
        if(!groups.has(currency))groups.set(currency,[]);
        groups.get(currency).push(value);
      }
      details=[...groups].map(([currency,values])=>{
        const scale=Math.max(2,...values.map(value=>(value.split('.')[1]||'').length));
        const numbers=values.map(value=>{const negative=value.startsWith('-');const [whole,fraction='']=value.replace(/^-/, '').split('.');const n=BigInt(whole+fraction.padEnd(scale,'0'));return negative?-n:n;});
        const sum=numbers.reduce((a,b)=>a+b,0n), count=BigInt(numbers.length);
        const average=(sum<0n?-1n:1n)*((sum<0n?-sum:sum)+count/2n)/count;
        const format=n=>{const sign=n<0n?'-':'';const digits=(n<0n?-n:n).toString().padStart(scale+1,'0');return sign+digits.slice(0,-scale).replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+digits.slice(-scale);};
        const min=numbers.reduce((a,b)=>a<b?a:b),max=numbers.reduce((a,b)=>a>b?a:b);
        return `<div class="sheet-summary-group"><h3>${esc(currency)} <small>${numbers.length} values</small></h3><dl><div><dt>Total</dt><dd>${format(sum)}</dd></div><div><dt>Average</dt><dd>${format(average)}</dd></div><div><dt>Min</dt><dd>${format(min)}</dd></div><div><dt>Max</dt><dd>${format(max)}</dd></div></dl></div>`;
      }).join('')||'<p>No numeric values in this selection.</p>';
    } else details='<p>Select Amount cells to see total, average, minimum and maximum.</p>';
    panel.innerHTML=`<h2>Selection</h2><p><strong>${chosen.length}</strong> ${chosen.length===1?'cell':'cells'} · ${esc(label)}</p>${details}<button type="button" data-sheet-clear-selection>Clear selection</button>`;
  }
  function refresh(host) {
    const result=selectedRows(), active=columns.filter(([key])=>visible.has(key));
    selection=null;
    const pages=Math.max(1,Math.ceil(result.length/100)); page=Math.min(page,pages-1);
    host.querySelector('[data-sheet-count]').textContent=`${result.length} of ${rows.length} transactions`;
    host.querySelector('colgroup').innerHTML='<col style="width:48px">'+active.map(([key])=>`<col data-sheet-col="${key}" style="width:${widths[key]}px">`).join('')+'<col style="width:90px">';
    host.querySelector('thead').innerHTML='<tr><th scope="col" class="sheet-row-number">#</th>'+active.map(([key,label])=>`<th scope="col" data-sheet-cell="${key}" aria-sort="${sort===key?(direction===1?'ascending':'descending'):'none'}"><button type="button" data-sheet-sort="${key}">${label} <span aria-hidden="true">${sort===key?(direction===1?'↑':'↓'):'↕'}</span></button><span class="sheet-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize ${label} column" aria-valuemin="80" aria-valuemax="600" aria-valuenow="${widths[key]}" data-sheet-resize="${key}"></span></th>`).join('')+'<th scope="col">Details</th></tr>';
    pageRows=result.slice(page*100,(page+1)*100);
    host.querySelector('tbody').innerHTML=pageRows.map((row,i)=>`<tr><th scope="row" class="sheet-row-number">${page*100+i+1}</th>${active.map(([key])=>`<td data-sheet-cell="${key}" data-sheet-row="${i}" tabindex="0" aria-selected="false" class="${key==='amount'?'sheet-amount':''}" title="${esc(row[key])}">${esc(row[key])}</td>`).join('')}<td><button type="button" data-action="transaction-detail" data-id="${esc(row.id)}">Open</button></td></tr>`).join('') || `<tr><td colspan="${active.length+2}" class="sheet-empty">No transactions match these filters.</td></tr>`;
    const freeze=host.querySelector('[data-sheet-freeze]');
    if(freezeThrough && !active.some(([key])=>key===freezeThrough))freezeThrough='';
    freeze.innerHTML='<option value="">No frozen columns</option>'+active.map(([key,label])=>`<option value="${key}" ${freezeThrough===key?'selected':''}>Through ${label}</option>`).join('');
    host.querySelector('[data-sheet-page]').textContent=`Page ${page+1} of ${pages}`;
    host.querySelector('[data-sheet-prev]').disabled=page===0;
    host.querySelector('[data-sheet-next]').disabled=page>=pages-1;
    applyWidths(host);
    updateSelection(host);
  }
  function mount(host, transactions, accounts, categories) {
    const name=(list,id,fallback)=>list.find(item=>item.id===id)?.name || fallback;
    rows=transactions.map((t,index)=>{
      const parts={type:[(t.event_type||'').replaceAll('_',' ')],category:unique((t.allocations||[]).map(a=>name(categories,a.category_id,'Uncategorized'))),account:unique((t.movements||[]).map(m=>name(accounts,m.account_id,'Unknown account'))),scope:unique((t.allocations||[]).map(a=>a.scope)),currency:[t.currency||'']};
      return {id:t.id,index,date:t.effective_date||'',description:t.description||'Untitled',type:parts.type.join(', '),category:parts.category.join(', '),account:parts.account.join(', '),scope:parts.scope.join(', '),amount:t.amount??'',currency:t.currency||'',parts};
    });
    page=0;
    const filterSelect=(key,label)=>`<details class="sheet-filter"><summary><span>${label}</span><strong data-sheet-filter-summary="${key}">${filters[key].length?filters[key].length+' selected':'All'}</strong></summary><div class="sheet-filter-options">${unique(rows.flatMap(row=>row.parts[key])).map(value=>`<label><input type="checkbox" data-sheet-multi="${key}" value="${esc(value)}" ${filters[key].includes(value)?'checked':''}> <span>${esc(value)}</span></label>`).join('')||'<span>No values</span>'}</div></details>`;
    host.innerHTML=`<div class="sheet-toolbar"><label class="sheet-search">Search<input type="search" data-sheet-filter="search" value="${esc(filters.search)}" placeholder="Search transactions"></label>${filterSelect('type','Type')}${filterSelect('category','Category')}${filterSelect('account','Account')}${filterSelect('scope','Scope')}${filterSelect('currency','Currency')}<label>From<input type="date" data-sheet-filter="from" value="${esc(filters.from)}"></label><label>To<input type="date" data-sheet-filter="to" value="${esc(filters.to)}"></label><button type="button" data-sheet-reset>Clear filters</button><details class="sheet-columns"><summary>Columns</summary><div>${columns.map(([key,label])=>`<label><input type="checkbox" data-sheet-column="${key}" ${visible.has(key)?'checked':''}> ${label}</label>`).join('')}</div></details><label>Freeze columns<select data-sheet-freeze aria-label="Freeze columns through"></select></label><button type="button" data-sheet-export>Export CSV</button></div><div class="sheet-status"><strong data-sheet-count aria-live="polite"></strong><span>One row per transaction · amounts are recorded transaction amounts</span></div><div class="sheet-content"><div class="sheet-scroll" tabindex="0" role="region" aria-label="Transaction spreadsheet"><table class="sheet-table"><colgroup></colgroup><thead></thead><tbody></tbody></table></div><aside class="sheet-summary" data-sheet-summary aria-live="polite" aria-label="Selection summary" hidden></aside></div><div class="sheet-pagination"><button type="button" data-sheet-prev>Previous</button><span data-sheet-page></span><button type="button" data-sheet-next>Next</button></div>`;
    host.addEventListener('input',event=>{const key=event.target.dataset.sheetFilter;if(key){filters[key]=event.target.value;page=0;refresh(host);}});
    host.addEventListener('change',event=>{
      const key=event.target.dataset.sheetColumn;
      if(key){event.target.checked?visible.add(key):visible.delete(key);refresh(host);}
      const multi=event.target.dataset.sheetMulti;
      if(multi){filters[multi]=[...host.querySelectorAll(`[data-sheet-multi="${multi}"]:checked`)].map(input=>input.value);host.querySelector(`[data-sheet-filter-summary="${multi}"]`).textContent=filters[multi].length?filters[multi].length+' selected':'All';page=0;refresh(host);}
      if(event.target.matches('[data-sheet-freeze]')){freezeThrough=event.target.value;refresh(host);}
    });
    function resize(key,value) {
      widths[key]=Math.max(80,Math.min(600,Math.round(value)));
      host.querySelector(`[data-sheet-col="${key}"]`).style.width=widths[key]+'px';
      host.querySelector(`[data-sheet-resize="${key}"]`).setAttribute('aria-valuenow',widths[key]);
      applyWidths(host);
    }
    host.addEventListener('pointerdown',event=>{
      const cell=event.target.closest('tbody td[data-sheet-cell]');
      if(!cell||event.button!==0||event.pointerType==='touch')return;
      event.preventDefault();cell.focus({preventScroll:true});
      const row=Number(cell.dataset.sheetRow),column=cell.dataset.sheetCell;
      selection={column,start:event.shiftKey&&selection?.column===column?selection.start:row,end:row};
      updateSelection(host);
      const move=e=>{const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('tbody td[data-sheet-cell]');if(target&&host.contains(target)){selection.end=Number(target.dataset.sheetRow);updateSelection(host);}};
      const end=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);};
      document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
    });
    host.addEventListener('keydown',event=>{
      const cell=event.target.closest('tbody td[data-sheet-cell]');if(!cell)return;
      const row=Number(cell.dataset.sheetRow),column=cell.dataset.sheetCell;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();selection={column,start:event.shiftKey&&selection?.column===column?selection.start:row,end:row};updateSelection(host);}
      if(event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)){
        event.preventDefault();const next=Math.max(0,Math.min(pageRows.length-1,row+(event.key==='ArrowDown'?1:-1)));
        selection={column,start:selection?.column===column?selection.start:row,end:next};updateSelection(host);
        host.querySelector(`tbody td[data-sheet-cell="${column}"][data-sheet-row="${next}"]`)?.focus();
      }
      if(event.key==='Escape'){selection=null;updateSelection(host);}
    });
    host.addEventListener('pointerdown',event=>{
      const handle=event.target.closest('[data-sheet-resize]');if(!handle||event.button!==0)return;
      event.preventDefault();const key=handle.dataset.sheetResize,start=event.clientX,width=widths[key];
      handle.setPointerCapture(event.pointerId);
      const move=e=>resize(key,width+e.clientX-start);
      const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    });
    host.addEventListener('keydown',event=>{const handle=event.target.closest('[data-sheet-resize]');if(!handle||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();resize(handle.dataset.sheetResize,widths[handle.dataset.sheetResize]+(event.key==='ArrowRight'?10:-10));});
    host.addEventListener('click',event=>{
      const button=event.target.closest('button'); if(!button)return;
      if(button.hasAttribute('data-sheet-clear-selection')){selection=null;updateSelection(host);}
      if(button.dataset.sheetSort){const key=button.dataset.sheetSort;direction=sort===key?-direction:1;sort=key;page=0;refresh(host);}
      if(button.hasAttribute('data-sheet-prev')){page--;refresh(host);}
      if(button.hasAttribute('data-sheet-next')){page++;refresh(host);}
      if(button.hasAttribute('data-sheet-reset')){Object.keys(filters).forEach(key=>filters[key]=filterKeys.includes(key)?[]:'');host.querySelectorAll('[data-sheet-filter]').forEach(input=>input.value='');host.querySelectorAll('[data-sheet-multi]').forEach(input=>input.checked=false);host.querySelectorAll('[data-sheet-filter-summary]').forEach(summary=>summary.textContent='All');page=0;refresh(host);}
      if(button.hasAttribute('data-sheet-export')){
        const active=columns.filter(([key])=>visible.has(key));
        const csvCell=value=>'"'+String(value??'').replace(/^[\t\r\n ]*[=+\-@]/,match=>"'"+match).replaceAll('"','""')+'"';
        const csv=[active.map(([,label])=>csvCell(label)).join(','),...selectedRows().map(row=>active.map(([key])=>csvCell(row[key])).join(','))].join('\r\n');
        const url=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='finwise-transactions.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
    });
    refresh(host);
  }
  window.finwiseSheet={mount};
})();
