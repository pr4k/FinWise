const test = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('../compact-money.js');

test('mobile shorthand uses Indian units and keeps the sign and currency', () => {
  assert.equal(format('20000.00', 'INR'), '₹20K');
  assert.equal(format('2000000.00', 'INR'), '₹20L');
  assert.equal(format('-28808.33', 'INR'), '−₹28.8K');
  assert.equal(format('12500000.00', 'INR'), '₹1.3Cr');
});

test('other currencies stay explicit and unknown balances stay unknown', () => {
  assert.equal(format('25000.00', 'USD'), 'USD 25K');
  assert.equal(format('999.50', 'USD'), 'USD 999.5');
  assert.equal(format(null, 'INR'), 'Unknown');
});
