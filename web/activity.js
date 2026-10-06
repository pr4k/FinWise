(() => {
  // At the same instant, a check follows movements and a start precedes them.
  const rank = entry => entry.kind === 'balance_check' ? 2 : entry.kind === 'transaction' ? 1 : 0;
  function timeline(transactions, markers, ledgerBalances, accountId = '') {
    const result = transactions.map(transaction => {
      const movement = transaction.movements.find(v => v.account_id === accountId) || transaction.movements[0];
      const ledger = movement && ledgerBalances.get(movement.account_id + ':' + transaction.id);
      const instant = transaction.effective_at || (ledger && ledger.effective_at) || transaction.effective_date + 'T10:00:00';
      return { kind: 'transaction', transaction, instant };
    });
    for (const { account, row } of markers) {
      result.push({ kind: row.event_type, account, row, instant: row.effective_at });
    }
    return result.sort((a, b) => Date.parse(b.instant) - Date.parse(a.instant) || rank(b) - rank(a) || String((a.transaction && a.transaction.id) || (a.row && a.row.check_id) || (a.account && a.account.id)).localeCompare(String((b.transaction && b.transaction.id) || (b.row && b.row.check_id) || (b.account && b.account.id))));
  }
  window.finwiseActivity = { timeline };
})();
