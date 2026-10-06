/* Category hierarchy helpers shared by every live view. */
(() => {
  function path(categories, key) {
    if (!key) return 'Uncategorized';
    const byId=new Map(categories.map(c=>[c.id,c]));
    const names=[]; const seen=new Set(); let current=byId.get(key);
    while(current && !seen.has(current.id)) {
      names.unshift(current.name); seen.add(current.id);
      current=current.parent_id?byId.get(current.parent_id):null;
    }
    return names.join(' › ') || 'Uncategorized';
  }
  function ordered(categories, kind) {
    const items=categories.filter(c=>!kind || c.kind===kind);
    const byId=new Map(items.map(c=>[c.id,c]));
    const children=new Map();
    for(const item of items) {
      const parent=byId.has(item.parent_id)?item.parent_id:null;
      if(!children.has(parent)) children.set(parent,[]);
      children.get(parent).push(item);
    }
    for(const group of children.values()) group.sort((a,b)=>a.name.localeCompare(b.name));
    const result=[]; const seen=new Set();
    function walk(parent,depth) {
      for(const item of children.get(parent)||[]) {
        if(seen.has(item.id)) continue;
        seen.add(item.id); result.push({category:item,depth}); walk(item.id,depth+1);
      }
    }
    walk(null,0);
    for(const item of items) if(!seen.has(item.id)) { seen.add(item.id); result.push({category:item,depth:0}); walk(item.id,1); }
    return result;
  }
  function rollup(rows,categories) {
    const byId=new Map(categories.map(c=>[c.id,c]));
    const values=new Map();
    for(const row of rows) {
      const fractional=(row.amount.split('.')[1]||'').length;
      const digits=row.amount.replace('.','');
      const money=BigInt(digits);
      let key=row.id || 'uncategorized'; const seen=new Set();
      while(key && !seen.has(key)) {
        seen.add(key);
        const old=values.get(key) || {minor:0n,scale:fractional,currency:row.currency,count:0};
        if(old.scale!==fractional || old.currency!==row.currency) throw new Error('Mixed money units in category report.');
        old.minor+=money; old.count+=row.count;
        values.set(key,old);
        key=byId.get(key)?.parent_id || null;
      }
    }
    const formatted=new Map();
    for(const [key,value] of values) {
      const abs=(value.minor<0n?-value.minor:value.minor).toString().padStart(value.scale+1,'0');
      const amount=(value.minor<0n?'-':'')+(value.scale?abs.slice(0,-value.scale)+'.'+abs.slice(-value.scale):abs);
      formatted.set(key,{amount,currency:value.currency,count:value.count});
    }
    return formatted;
  }
  window.finwiseCategories={path,ordered,rollup};
})();
