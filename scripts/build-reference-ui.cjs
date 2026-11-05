// Vendor the supplied visual reference into the live app without its demo scripts.
// Run after updating FinWise/style.css or FinWise/mobile.css.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function scope(css,prefix='.reference-page') {
  css=css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/@import[^;]*;/g,'');
  return css.replace(/([^{}]+)\{/g,(rule,selectors)=>{
    if(selectors.trim().startsWith('@')||/^(from|to|[0-9.]+%)(\s*,\s*(from|to|[0-9.]+%))*$/.test(selectors.trim()))return rule;
    return selectors.split(',').map(selector=>{
      selector=selector.trim();
      if(selector===':root'||selector==='body')return prefix;
      return prefix+' '+selector;
    }).join(',')+'{';
  });
}
const css=['style.css','mobile.css'].map(file=>scope(fs.readFileSync(path.join(root,'FinWise',file),'utf8'))).join('\n')+'\n'+scope(fs.readFileSync(path.join(root,'FinWise/planner.css'),'utf8'),'.reference-page .planner-module');
fs.writeFileSync(path.join(root,'web/reference-components.css'),'/* Generated from the supplied FinWise reference. Do not load the demo scripts. */\n'+css+'\n');
