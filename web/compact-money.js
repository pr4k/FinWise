/* Rounded display values for narrow summary cards. Ledger and table values remain exact. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.finwiseCompactMoney = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function format(value, currency) {
    if (value == null) return 'Unknown';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return `${currency} ${value}`;
    const absolute = Math.abs(numeric);
    const prefix = numeric < 0 ? '−' : '';
    const marker = currency === 'INR' ? '₹' : `${currency} `;
    const units = currency === 'INR'
      ? [[10000000, 'Cr'], [100000, 'L'], [1000, 'K']]
      : [[1000000000, 'B'], [1000000, 'M'], [1000, 'K']];
    const selected = units.find(([threshold]) => absolute >= threshold);
    if (selected) {
      const [divisor, suffix] = selected;
      const digits = absolute / divisor < 100 ? 1 : 0;
      const scaled = new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(absolute / divisor);
      return `${prefix}${marker}${scaled}${suffix}`;
    }
    const fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return `${prefix}${marker}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: fractionDigits }).format(absolute)}`;
  }
  return { format };
});
