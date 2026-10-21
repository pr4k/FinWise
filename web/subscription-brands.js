(() => {
  const brands = [
    {slug:'primevideo', color:'#dceeff', match:/\b(?:prime\s*video|amazon\s*prime|amzn\s*prime)\b/i},
    {slug:'amazon', color:'#fff2df', match:/\b(?:amazon|amzn)\b/i},
    {slug:'netflix', color:'#fff0f0', match:/\bnetflix\b/i},
    {slug:'backblaze', color:'#fff0f0', match:/\bbackblaze\b/i},
    {slug:'vultr', color:'#eaf3ff', match:/\bvultr\b/i},
    {slug:'azure', color:'#eaf5ff', match:/\bazure\b/i},
    {slug:'spotify', color:'#e8faee', match:/\bspotify\b/i},
    {slug:'youtubemusic', color:'#fff0f0', match:/\byoutube\s*music\b/i},
    {slug:'youtube', color:'#fff0f0', match:/\b(?:youtube|you\s*tube)\b/i},
    {slug:'disneyplus', color:'#eaf4ff', match:/\bdisney\s*(?:\+|plus\b)/i},
    {slug:'applemusic', color:'#fff0f2', match:/\bapple\s*music\b/i},
    {slug:'appletv', color:'#f0f1f4', match:/\bapple\s*tv\b/i},
    {slug:'icloud', color:'#eef7ff', match:/\bicloud\b/i},
    {slug:'audible', color:'#fff4e7', match:/\baudible\b/i},
    {slug:'canva', color:'#e9f9fb', match:/\bcanva\b/i},
    {slug:'openai', color:'#eaf6f1', match:/\b(?:chatgpt|openai)\b/i}
  ];
  const fallbackColors=['#e9e4fa','#dceef6','#e3f2e8','#fbe9df','#f8e7ef','#ececf4'];
  function resolve(name) {
    const label=String(name??'').trim();
    const brand=brands.find(item=>item.match.test(label));
    const initial=label.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() || '?';
    const hash=Array.from(label).reduce((value,char)=>(value*31+char.codePointAt(0))>>>0,0);
    return {slug:brand?.slug||null,initial,color:brand?.color||fallbackColors[hash%fallbackColors.length]};
  }
  function markup(name,escape) {
    const brand=resolve(name);
    return `<span class="subscription-avatar" style="--avatar-bg:${brand.color}" aria-hidden="true"><span class="subscription-initial">${escape(brand.initial)}</span>${brand.slug?`<img src="/brand-logos/${brand.slug}.svg" alt="">`:''}</span>`;
  }
  function hydrate(host) {
    host.querySelectorAll('.subscription-avatar img').forEach(img=>{
      const show=()=>{if(img.naturalWidth>0) img.parentElement.classList.add('has-logo');};
      img.addEventListener('load',show,{once:true});
      if(img.complete) show();
    });
  }
  window.finwiseSubscriptionBrands={resolve,markup,hydrate};
})();
