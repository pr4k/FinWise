/* URL state contains only view preferences. No account or transaction data is stored here. */
(() => {
  const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const validScope = value => ['personal','family','combined'].includes(value);
  const accountTypes = ['bank','credit_card','cash','settle_up'];
  const eventTypes = ['expense','income','refund','transfer','investment','investment_withdrawal'];
  const extraFilters={transactionType:'transaction_type',status:'classification_status',category:'category_id',person:'member_id',direction:'direction',minAmount:'min_amount',maxAmount:'max_amount',search:'q',from:'from',to:'to',currency:'currency',sort:'sort',secondarySort:'secondary_sort'};
  function readFilters(search) {
    const params=new URLSearchParams(search);
    const result = {
      account:params.get('account') || '',
      accountType:accountTypes.includes(params.get('account_type'))?params.get('account_type'):'',
      eventType:eventTypes.includes(params.get('event_type'))?params.get('event_type'):''
    };
    for(const [key,param] of Object.entries(extraFilters)) if(params.get(param)) result[key]=params.get(param);
    // Older Investment links selected only generated ledger movements, missing imported/SIP allocations.
    if(result.eventType==='investment') {
      if(!result.transactionType) result.transactionType='investment';
      result.eventType='';
    }
    return result;
  }
  function read(search, fallbackMonth) {
    const params = new URLSearchParams(search);
    const month = params.get('month');
    const scope = params.get('scope');
    return { month:validMonth(month) ? month : fallbackMonth, scope:validScope(scope) ? scope : 'personal' };
  }
  function save(month, scope, current, replace, filters) {
    if (!validMonth(month) || !validScope(scope)) throw new Error('Invalid report view.');
    const url = new URL(current);
    url.searchParams.set('month',month);
    url.searchParams.set('scope',scope);
    if(filters) {
      for(const [param,value] of [['account',filters.account],['account_type',filters.accountType],['event_type',filters.eventType],...Object.entries(extraFilters).map(([key,param])=>[param,filters[key]])]) {
        if(value) url.searchParams.set(param,value); else url.searchParams.delete(param);
      }
    }
    replace(url.pathname + url.search + url.hash);
  }
  function transactionsPath(month, monthOnly, filters={}, scope='') {
    const params=new URLSearchParams();
    if(scope) {
      if(!validScope(scope)) throw new Error('Invalid report scope.');
      params.set('scope',scope);
    }
    if(monthOnly) {
      if (!validMonth(month)) throw new Error('Invalid report month.');
      const [year, number] = month.split('-').map(Number);
      const end = `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2,'0')}-01`;
      params.set('from',`${month}-01`); params.set('to',end);
    }
    if(filters.account) params.set('account_id',filters.account);
    if(filters.accountType) {
      if(!accountTypes.includes(filters.accountType)) throw new Error('Invalid account type.');
      params.set('account_type',filters.accountType);
    }
    if(filters.eventType) {
      if(!eventTypes.includes(filters.eventType)) throw new Error('Invalid transaction type.');
      params.set(filters.eventType==='investment'?'transaction_type':'event_type',filters.eventType);
    }
    for(const [key,param] of Object.entries(extraFilters)) if(filters[key]) params.set(param,filters[key]);
    return `transactions${params.size?`?${params}`:''}`;
  }
  window.finwiseViewState = { read, readFilters, save, transactionsPath };
})();
