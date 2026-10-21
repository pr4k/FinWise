const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../subscription-brands.js'),'utf8'),context);
const brands=context.window.finwiseSubscriptionBrands;
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

test('specific subscription names resolve to local logos',()=>{
  for(const [name,slug] of [
    ['NETFLIX.COM','netflix'],['Amazon Prime Video','primevideo'],['AMZN PRIME','primevideo'],['AMAZON PAYMENTS','amazon'],
    ['Backblaze B2','backblaze'],['VULTR.COM','vultr'],['Microsoft Azure','azure'],
    ['Spotify Premium','spotify'],['YouTube Music','youtubemusic'],['Disney+','disneyplus'],
    ['ChatGPT Plus','openai']
  ]) {
    assert.equal(brands.resolve(name).slug,slug);
    assert.ok(fs.existsSync(path.join(__dirname,'../brand-logos',`${slug}.svg`)));
  }
});

test('unknown names use their first meaningful character and escape markup',()=>{
  assert.equal(brands.resolve(' *Acme Cloud').initial,'A');
  assert.equal(brands.resolve('Netflex').slug,null);
  assert.equal(brands.resolve('').initial,'?');
  const html=brands.markup('<script>alert(1)</script>',escape);
  assert.match(html,/subscription-initial">S<\/span>/);
  assert.doesNotMatch(html,/<script>/);
  assert.doesNotMatch(html,/<img/);
});

test('known logo markup retains an initial until the image loads',()=>{
  const html=brands.markup('Netflix',escape);
  assert.match(html,/subscription-initial">N<\/span>/);
  assert.match(html,/src="\/brand-logos\/netflix.svg"/);
  assert.match(html,/<img[^>]*alt="">/);
});
