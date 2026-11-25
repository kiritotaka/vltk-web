const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('original market adapter runs inside the game bundle and uses the existing modal',async()=>{
  const manifest=require('../src/client/modules.json');
  assert.ok(manifest.modules.some(module=>module.file==='online/local-market-01.js'));
  const source=fs.readFileSync(path.join(__dirname,'../src/client/online/local-market-01.js'),'utf8');
  const pages=[];
  const scope={
    URLSearchParams,Number,String,
    D:value=>String(value),
    m:()=>null,
    J:(content,callback)=>{ pages.push(content);callback?.(); },
    Y0:(tab)=>'original '+tab,
    fetch:async()=>({ok:true,json:async()=>[]}),
  };
  vm.runInNewContext(source,scope);
  assert.equal(typeof scope.localMarket.open,'function');
  assert.equal(scope.Y0('acc'),'original acc','account tab should be untouched');
  scope.Y0('mkt');
  assert.match(pages[0],/id="mktTabs"/);
  assert.match(pages[0],/Bày bán/);
  assert.match(pages[0],/Hàng của tôi/);
  assert.match(pages[0],/mktListings/);
  assert.doesNotMatch(source,/market\.html/);
});

test('the native market uses the authenticated Fastify transaction API',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/client/online/local-market-01.js'),'utf8');
  assert.match(source,/fetch\('\/api\/market\/'/);
  assert.match(source,/api\('transactions', \{ method: 'POST'/);
  assert.match(source,/sessionStorage\.setItem\(key, pending\)/);
  assert.match(source,/Gửi lại yêu cầu/);
  const game=fs.readFileSync(path.join(__dirname,'../src/client/ui/world-shell-01.js'),'utf8');
  assert.match(game,/localMarket\.open\(\)/);
});

test('the modal reuses the original market request after an uncertain response and reload',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/client/online/local-market-01.js'),'utf8');
  const storage = new Map();
  const posts = [];
  let ids = 0;
  function element() {
    return {
      children: [],
      get childElementCount() { return this.children.length; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren() { this.children = []; },
    };
  }
  function mount() {
    const elements = new Map();
    const root = {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      querySelectorAll() { return []; },
    };
    const scope = {
      URLSearchParams, m: () => root, J: (_html, ready) => ready(),
      document: { createElement: element },
      crypto: { randomUUID: () => 'request-' + ++ids },
      sessionStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
      },
      async fetch(url, options) {
        if (options.method === 'POST') {
          posts.push(options.body);
          if (posts.length === 1) throw new Error('Connection lost');
        }
        const payload = url.endsWith('/mine') ? { accountId: 'buyer', wallet: { gold: 100, knb: 0 } }
          : { listings: [{ id: 'order', item_name: 'Kiếm', seller_name: 'seller', price: 10, currency: 'gold' }] };
        return { ok: true, json: async () => payload };
      },
    };
    vm.runInNewContext(source,scope);
    scope.localMarket.open();
    return root;
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));
  let root = mount();
  await settle();
  const [listing] = root.querySelector('#mktListings').children;
  listing.children.find(node => node.textContent === 'Mua').onclick();
  await settle();
  assert.equal(storage.size, 1);

  root = mount();
  await settle();
  const [retry] = root.querySelector('#mktPending').children;
  assert.equal(retry.textContent, 'Gửi lại yêu cầu');
  retry.onclick();
  await settle();
  assert.equal(ids, 1);
  assert.deepEqual(posts, [posts[0], posts[0]]);
  assert.equal(JSON.parse(posts[0]).accountId, 'buyer');
  assert.equal(storage.size, 0);
});
