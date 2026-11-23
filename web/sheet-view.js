/* A read-only, client-side exploration of the transactions visible to this user. */
(() => {
  const columns=[['date','Date'],['description','Description'],['type','Type'],['category','Category'],['account','Account'],['scope','Scope'],['amount','Amount'],['currency','Currency']];
  let rows=[], sort='date', direction=-1, page=0;
  const filters={search:'',type:'',category:'',account:'',scope:'',currency:'',from:'',to:''};
  const visible=new Set(columns.map(([key])=>key));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function unique(values) { return [...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
  function selectedRows() {
    const query=filters.search.trim().toLocaleLowerCase();
    return rows.filter(row=>(!query||columns.some(([key])=>String(row[key]).toLocaleLowerCase().includes(query))) &&
      ['type','category','account','scope','currency'].every(key=>!filters[key]||row.parts[key].includes(filters[key])) &&
      (!filters.from||row.date>=filters.from)&&(!filters.to||row.date<=filters.to))
      .sort((a,b)=>direction*(sort==='amount'?Number(a.amount)-Number(b.amount):String(a[sort]).localeCompare(String(b[sort]),undefined,{numeric:true,sensitivity:'base'})) || a.index-b.index);
  }
  function refresh(host) {
    const result=selectedRows(), active=columns.filter(([key])=>visible.has(key));
    const pages=Math.max(1,Math.ceil(result.length/100)); page=Math.min(page,pages-1);
    host.querySelector('[data-sheet-count]').textContent=`${result.length} of ${rows.length} transactions`;
    host.querySelector('thead').innerHTML='<tr><th scope="col" class="sheet-row-number">#</th>'+active.map(([key,label])=>`<th scope="col" aria-sort="${sort===key?(direction===1?'ascending':'descending'):'none'}"><button type="button" data-sheet-sort="${key}">${label} <span aria-hidden="true">${sort===key?(direction===1?'↑':'↓'):'↕'}</span></button></th>`).join('')+'<th scope="col">Details</th></tr>';
    host.querySelector('tbody').innerHTML=result.slice(page*100,(page+1)*100).map((row,i)=>`<tr><th scope="row" class="sheet-row-number">${page*100+i+1}</th>${active.map(([key])=>`<td class="${key==='amount'?'sheet-amount':''}">${esc(row[key])}</td>`).join('')}<td><button type="button" data-action="transaction-detail" data-id="${esc(row.id)}">Open</button></td></tr>`).join('') || `<tr><td colspan="${active.length+2}" class="sheet-empty">No transactions match these filters.</td></tr>`;
    host.querySelector('[data-sheet-page]').textContent=`Page ${page+1} of ${pages}`;
    host.querySelector('[data-sheet-prev]').disabled=page===0;
    host.querySelector('[data-sheet-next]').disabled=page>=pages-1;
  }
  function mount(host, transactions, accounts, categories) {
    const name=(list,id,fallback)=>list.find(item=>item.id===id)?.name || fallback;
    rows=transactions.map((t,index)=>{
      const parts={type:[(t.event_type||'').replaceAll('_',' ')],category:unique((t.allocations||[]).map(a=>name(categories,a.category_id,'Uncategorized'))),account:unique((t.movements||[]).map(m=>name(accounts,m.account_id,'Unknown account'))),scope:unique((t.allocations||[]).map(a=>a.scope)),currency:[t.currency||'']};
      return {id:t.id,index,date:t.effective_date||'',description:t.description||'Untitled',type:parts.type.join(', '),category:parts.category.join(', '),account:parts.account.join(', '),scope:parts.scope.join(', '),amount:t.amount??'',currency:t.currency||'',parts};
    });
    page=0;
    const filterSelect=(key,label)=>`<label>${label}<select data-sheet-filter="${key}"><option value="">All ${label.toLowerCase()}</option>${unique(rows.flatMap(row=>row.parts[key])).map(value=>`<option value="${esc(value)}" ${filters[key]===value?'selected':''}>${esc(value)}</option>`).join('')}</select></label>`;
    host.innerHTML=`<div class="sheet-toolbar"><label class="sheet-search">Search<input type="search" data-sheet-filter="search" value="${esc(filters.search)}" placeholder="Search transactions"></label>${filterSelect('type','Type')}${filterSelect('category','Category')}${filterSelect('account','Account')}${filterSelect('scope','Scope')}${filterSelect('currency','Currency')}<label>From<input type="date" data-sheet-filter="from" value="${esc(filters.from)}"></label><label>To<input type="date" data-sheet-filter="to" value="${esc(filters.to)}"></label><button type="button" data-sheet-reset>Clear filters</button><details class="sheet-columns"><summary>Columns</summary><div>${columns.map(([key,label])=>`<label><input type="checkbox" data-sheet-column="${key}" ${visible.has(key)?'checked':''}> ${label}</label>`).join('')}</div></details><button type="button" data-sheet-export>Export CSV</button></div><div class="sheet-status"><strong data-sheet-count aria-live="polite"></strong><span>One row per transaction · amounts are recorded transaction amounts</span></div><div class="sheet-scroll" tabindex="0" role="region" aria-label="Transaction spreadsheet"><table class="sheet-table"><thead></thead><tbody></tbody></table></div><div class="sheet-pagination"><button type="button" data-sheet-prev>Previous</button><span data-sheet-page></span><button type="button" data-sheet-next>Next</button></div>`;
    host.addEventListener('input',event=>{const key=event.target.dataset.sheetFilter;if(key){filters[key]=event.target.value;page=0;refresh(host);}});
    host.addEventListener('change',event=>{const key=event.target.dataset.sheetColumn;if(key){event.target.checked?visible.add(key):visible.delete(key);refresh(host);}});
    host.addEventListener('click',event=>{
      const button=event.target.closest('button'); if(!button)return;
      if(button.dataset.sheetSort){const key=button.dataset.sheetSort;direction=sort===key?-direction:1;sort=key;page=0;refresh(host);}
      if(button.hasAttribute('data-sheet-prev')){page--;refresh(host);}
      if(button.hasAttribute('data-sheet-next')){page++;refresh(host);}
      if(button.hasAttribute('data-sheet-reset')){Object.keys(filters).forEach(key=>filters[key]='');host.querySelectorAll('[data-sheet-filter]').forEach(input=>input.value='');page=0;refresh(host);}
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
