// Reuse the existing in-game Market modal. This is the read-only Supabase
// catalog phase; transactions require a server-authoritative escrow protocol.
var localMarket = (() => {
  const project = 'https://atchexthhvseabeacotj.supabase.co';
  const key = 'sb_publishable_0uCQ2M95mnhLMsmki5YeDg_tIPXMLdw';
  const state = { tab:'buy', query:'', currency:'', sort:'new', page:0 };
  const escapeHtml = value => typeof D === 'function' ? D(String(value)) : String(value).replace(/[&<>"']/g,
    char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const displayMoney = (amount, cur) =>
    Number(amount).toLocaleString('vi-VN') + (cur === 'knb' ? ' KNB' : ' lượng');

  async function readListings() {
    const params = new URLSearchParams({
      select: 'id,seller_name,item_name,price,currency,created_at',
      status: 'eq.active',
      order: state.sort === 'lo' ? 'price.asc' : state.sort === 'hi' ? 'price.desc' : 'created_at.desc',
      limit: '15', offset: String(state.page * 15),
    });
    const query = state.query.replace(/[,%.*()]/g, ' ').trim();
    if (query) params.set('or', '(item_name.ilike.*' + query + '*,seller_name.ilike.*' + query + '*)');
    if (state.currency) params.set('currency', 'eq.' + state.currency);
    const response = await fetch(project + '/rest/v1/market_listings?' + params, {
      headers: { apikey:key }, cache:'no-store',
    });
    if (!response.ok) throw Error('Supabase HTTP ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data)) throw Error('Phản hồi Chợ không hợp lệ');
    return data;
  }

  function renderNotice(root, text) {
    const node = root.querySelector('#mktStatus');
    if (node) node.textContent = text;
  }

  async function refresh() {
    const body = m('#mBody');
    if (!body?.querySelector('#localMarket')) return;
    if (state.tab !== 'buy') return;
    renderNotice(body, 'Đang tải hàng hóa…');
    try {
      const listings = await readListings();
      const list = body.querySelector('#mktListings');
      if (!list) return;
      list.replaceChildren();
      for (const item of listings) {
        const row = document.createElement('div'); row.className = 'nmrow';
        const details = document.createElement('span');
        const title = document.createElement('b'); title.textContent = item.item_name;
        const seller = document.createElement('small'); seller.className = 'dim';
        seller.textContent = 'Người bán: ' + item.seller_name;
        details.append(title, document.createElement('br'), seller);
        const price = document.createElement('span'); price.className='cp';
        price.textContent=displayMoney(item.price,item.currency);
        row.append(details,price); list.appendChild(row);
      }
      renderNotice(body, listings.length ? listings.length + ' món trên trang ' + (state.page+1)
        : 'Chợ chưa có hàng ở bộ lọc này.');
      const previous=body.querySelector('#mktPrev'); if(previous)previous.disabled=state.page===0;
      const next=body.querySelector('#mktNext'); if(next)next.disabled=listings.length<15;
    } catch (error) {
      renderNotice(body, 'Không tải được danh sách Chợ: ' + (error.message||error));
    }
  }

  function open(tab = 'buy') {
    state.tab = ['buy','sell','mine'].includes(tab) ? tab : 'buy';
    const tabs = [['buy','Mua'],['sell','Bày bán'],['mine','Hàng của tôi']];
    J(`<section id="localMarket">
      <h3>🌐 Chợ Giang Hồ</h3>
      <div class="seg" id="mktTabs">${tabs.map(([value,label]) => `<button class="btn sm${state.tab===value?' on':''}" data-tab="${value}">${label}</button>`).join('')}</div>
      ${state.tab === 'buy' ? `<div class="row">
        <input id="mktSearch" placeholder="Tìm tên vật phẩm / người bán" maxlength="60" value="${escapeHtml(state.query)}">
        <button type="button" class="btn sm" id="mktFind">Tìm</button>
      </div><div class="row">
        <select id="mktCurrency"><option value="">Mọi tiền tệ</option>
          <option value="gold"${state.currency==='gold'?' selected':''}>Lượng</option>
          <option value="knb"${state.currency==='knb'?' selected':''}>KNB</option></select>
        <select id="mktSort"><option value="new">Mới nhất</option>
          <option value="lo"${state.sort==='lo'?' selected':''}>Giá thấp đến cao</option>
          <option value="hi"${state.sort==='hi'?' selected':''}>Giá cao đến thấp</option></select>
      </div><div id="mktListings" class="shoplist"></div>
      <div class="btnrow"><button class="btn sm" id="mktPrev">◀</button>
        <span>Trang ${state.page + 1}</span><button class="btn sm" id="mktNext">▶</button>
        <button class="btn sm" id="mktReload">Tải lại</button></div>`
      : '<p class="desc">Tính năng này đang được kết nối với tài khoản và hành trang trên máy chủ. Chưa cho phép chuyển tiền hoặc vật phẩm để tránh mất đồ hay nhân đôi đồ.</p>'}
      <p id="mktStatus" class="dim small" role="status"></p>
    </section>`, () => {
      const root=m('#localMarket');
      root?.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => open(button.dataset.tab));
      const search=root?.querySelector('#mktSearch');
      const execute=()=>{state.query=search?.value.trim()||'';state.page=0;void refresh();};
      if(search)search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();execute();}};
      const find=root?.querySelector('#mktFind');if(find)find.onclick=execute;
      const currency=root?.querySelector('#mktCurrency');if(currency)currency.onchange=()=>{state.currency=currency.value;state.page=0;void refresh();};
      const sort=root?.querySelector('#mktSort');if(sort)sort.onchange=()=>{state.sort=sort.value;state.page=0;void refresh();};
      const prev=root?.querySelector('#mktPrev');if(prev)prev.onclick=()=>{state.page=Math.max(0,state.page-1);open();};
      const next=root?.querySelector('#mktNext');if(next)next.onclick=()=>{state.page++;open();};
      const reload=root?.querySelector('#mktReload');if(reload)reload.onclick=()=>void refresh();
      void refresh();
    });
  }
  return { open, refresh };
})();

// Route the original online market tab to the game-local Market adapter,
// leaving the other network tabs and original modal framework unchanged.
if (typeof Y0 === 'function') {
  const upstreamMarketPanel = Y0;
  Y0 = function (tab, ...args) {
    if (tab === 'mkt') return localMarket.open();
    return upstreamMarketPanel(tab, ...args);
  };
}
