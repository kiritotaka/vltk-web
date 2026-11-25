// The existing Chợ modal uses Fastify for both browsing and settlement.
var localMarket = (() => {
  const state = { tab: 'buy', query: '', currency: '', sort: 'new', page: 0 };
  let revision = 0;
  let submitting = false;
  let inventoryCache = null;
  const currentSlot = () => typeof y8 === 'function' ? y8() : undefined;
  const money = (amount, unit) => Number(amount).toLocaleString('vi-VN') + (unit === 'knb' ? ' KNB' : ' lượng');

  async function api(path, options) {
    const response = await fetch('/api/market/' + path, { cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Không kết nối được Chợ.'), { status: response.status });
    return result;
  }

  function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'btn sm';
    node.textContent = label;
    node.onclick = action;
    return node;
  }

  function row(name, detail) {
    const node = document.createElement('div');
    node.className = 'nmrow';
    const title = document.createElement('span');
    title.textContent = name;
    if (detail) {
      const label = document.createElement('small');
      label.className = 'dim';
      label.textContent = detail;
      title.append(document.createElement('br'), label);
    }
    node.append(title);
    return node;
  }

  function status(root, message) {
    root.querySelector('#mktStatus').textContent = message;
  }

  async function transact(root, key, command) {
    if (submitting) return;
    submitting = true;
    let pending;
    try {
      pending = sessionStorage.getItem(key);
      if (command && pending) throw new Error('Hãy gửi lại yêu cầu trước khi bắt đầu giao dịch khác.');
      if (!pending && command) {
        if (command.action === 'sell' && currentSlot() && typeof window !== 'undefined' && window.localGameStorage) {
          if (typeof $ === 'function') $();
          await window.localGameStorage.flush();
          if (window.localGameStorage.pending) throw new Error('Hãy đợi Hành trang đồng bộ rồi thử lại.');
        }
        pending = JSON.stringify({ ...command, requestId: crypto.randomUUID() });
        sessionStorage.setItem(key, pending);
      }
      if (!pending) return;
      status(root, 'Đang xử lý giao dịch…');
      const result = await api('transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pending });
      sessionStorage.removeItem(key);
      if (result.reloadCharacter) { location.reload(); return; }
      inventoryCache = null;
      const inventoryPanel = m('#serverCharacterInventory');
      if (inventoryPanel) renderInventory(inventoryPanel);
      const current = m('#localMarket');
      if (current) void refresh(current, 'Giao dịch đã hoàn tất.');
    } catch (error) {
      // A lost response can follow a successful commit. Preserve the exact
      // request until a definitive result can be obtained from the server.
      if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
        sessionStorage.removeItem(key);
      }
      const current = m('#localMarket');
      if (current) void refresh(current, error.message);
    } finally {
      submitting = false;
    }
  }

  async function refresh(root, message) {
    const version = ++revision;
    status(root, 'Đang tải Chợ…');
    const panel = root.querySelector('#mktListings');
    const controls = root.querySelector('#mktPending');
    const params = new URLSearchParams({ q: state.query, currency: state.currency, sort: state.sort, page: String(state.page) });
    const character = currentSlot();
    try {
      if (state.tab === 'sell' && character && typeof window !== 'undefined' && window.localGameStorage) {
        await window.localGameStorage.flush();
        if (window.localGameStorage.pending) throw new Error('Hãy đợi Hành trang đồng bộ rồi thử lại.');
        if (version !== revision || m('#localMarket') !== root || currentSlot() !== character) return;
      }
      const [mine, catalog, inventory] = await Promise.all([api('mine'),
        state.tab === 'buy' ? api('listings?' + params) : null,
        state.tab === 'sell' && character ? api('inventory/' + character) : { items: [] },
      ]);
      if (version !== revision || m('#localMarket') !== root) return;
      const key = 'vltk-market-request:' + mine.accountId;
      const pending = sessionStorage.getItem(key);
      const addAction = (node, label, command) => {
        const action = button(label, () => void transact(root, key, { ...command, accountId: mine.accountId }));
        action.disabled = !!pending;
        node.append(action);
      };
      controls.replaceChildren();
      if (pending) controls.append(button('Gửi lại yêu cầu', () => void transact(root, key)));
      root.querySelector('#mktWallet').textContent = 'Ví Chợ: ' + money(mine.wallet.gold, 'gold') + ' · ' + money(mine.wallet.knb, 'knb');
      panel.replaceChildren();
      if (catalog) {
        for (const listing of catalog.listings) {
          const node = row(listing.item_name, 'Người bán: ' + listing.seller_name);
          const price = document.createElement('span');
          price.className = 'cp';
          price.textContent = money(listing.price, listing.currency);
          node.append(price);
          if (!listing.own) addAction(node, 'Mua', { action: 'buy', target: listing.id });
          panel.append(node);
        }
        root.querySelector('#mktPrev').disabled = state.page === 0;
        root.querySelector('#mktNext').disabled = !catalog.hasMore;
      } else if (state.tab === 'sell') {
        for (const item of [...inventory.items, ...mine.items]) {
          const node = row(item.name, item.item ? 'Hành trang · Cấp ' + (item.item.lvl || '—') : 'Kho Chợ');
          const price = document.createElement('input');
          price.type = 'number';
          price.min = '1';
          price.step = '1';
          price.placeholder = 'Giá bán';
          price.setAttribute('aria-label', 'Giá bán ' + item.name);
          const unit = document.createElement('select');
          unit.setAttribute('aria-label', 'Đơn vị tiền');
          unit.append(new Option('Lượng', 'gold'), new Option('KNB', 'knb'));
          const sell = button('Bày bán', () => {
            if (!Number.isSafeInteger(price.valueAsNumber) || price.valueAsNumber <= 0) {
              status(root, 'Nhập giá bán là số nguyên dương.');
              return;
            }
            void transact(root, key, {
              action: 'sell', target: item.id, price: price.valueAsNumber, currency: unit.value, accountId: mine.accountId,
              ...(character ? { character } : {}),
            });
          });
          sell.disabled = !!pending;
          node.append(price, unit, sell);
          panel.append(node);
        }
      } else {
        for (const order of mine.orders) {
          const label = order.status === 'active' ? 'Đang bày bán' : order.status === 'cancelled' ? 'Đã hủy'
            : order.received ? 'Đã nhận' : order.own ? 'Chờ nhận tiền' : 'Chờ nhận vật phẩm';
          const node = row(order.item_name, label + ' · ' + money(order.price, order.currency));
          if (order.status === 'active') addAction(node, 'Hủy', { action: 'cancel', target: order.id });
          if (order.status === 'sold' && !order.received) addAction(node, 'Nhận', { action: 'receive', target: order.id, ...(character ? { character } : {}) });
          panel.append(node);
        }
      }
      status(root, message || (pending ? 'Đang chờ kết quả của yêu cầu trước.' : panel.childElementCount ? '' :
        state.tab === 'buy' ? 'Chợ chưa có hàng ở bộ lọc này.' : state.tab === 'sell' ? 'Hành trang chưa có vật phẩm do máy chủ quản lý để bày bán.' : 'Chưa có giao dịch.'));
    } catch (error) {
      if (version === revision && m('#localMarket') === root) status(root, error.message);
    }
  }

  function renderInventory(panel) {
    const slot = currentSlot();
    if (!slot) return;
    if (inventoryCache?.slot !== slot || inventoryCache.until < Date.now()) {
      inventoryCache = { slot, until: Date.now() + 5000, data: api('inventory/' + slot) };
    }
    panel.textContent = 'Đang tải Hành trang máy chủ…';
    void inventoryCache.data.then(({ items }) => {
      if (!panel.isConnected || currentSlot() !== slot) return;
      panel.replaceChildren();
      if (!items.length) { panel.textContent = 'Chưa có vật phẩm do máy chủ quản lý.'; return; }
      for (const item of items) if (!item.legacy) panel.append(row(item.name, 'Cấp ' + item.item.lvl));
      panel.append(button('Bày bán', () => open('sell')));
    }).catch(error => { if (panel.isConnected) panel.textContent = error.message; });
  }

  function open(tab = 'buy') {
    state.tab = ['buy', 'sell', 'mine'].includes(tab) ? tab : 'buy';
    if (state.tab === 'sell' && typeof window !== 'undefined' && window.localGameStorage && typeof $ === 'function') $();
    const tabs = [['buy', 'Mua'], ['sell', 'Bày bán'], ['mine', 'Hàng của tôi']];
    J(`<section id="localMarket">
      <h3>🌐 Chợ Giang Hồ</h3>
      <div class="seg" id="mktTabs">${tabs.map(([value, label]) => `<button class="btn sm${state.tab === value ? ' on' : ''}" data-tab="${value}">${label}</button>`).join('')}</div>
      <p id="mktWallet" class="dim small"></p>
      ${state.tab === 'buy' ? `<div class="row">
        <input id="mktSearch" placeholder="Tìm tên vật phẩm / người bán" maxlength="60">
        <button type="button" class="btn sm" id="mktFind">Tìm</button>
      </div><div class="row">
        <select id="mktCurrency"><option value="">Mọi tiền tệ</option><option value="gold">Lượng</option><option value="knb">KNB</option></select>
        <select id="mktSort"><option value="new">Mới nhất</option><option value="lo">Giá thấp đến cao</option><option value="hi">Giá cao đến thấp</option></select>
      </div>` : '<p class="desc">Chọn vật phẩm trong Hành trang do máy chủ quản lý hoặc Kho Chợ.</p>'}
      <div id="mktListings" class="shoplist"></div>
      <div class="btnrow">${state.tab === 'buy' ? `<button class="btn sm" id="mktPrev" disabled>◀</button>
        <span>Trang ${state.page + 1}</span><button class="btn sm" id="mktNext" disabled>▶</button>` : ''}
        <button class="btn sm" id="mktReload">Tải lại</button><span id="mktPending"></span></div>
      <p id="mktStatus" class="dim small" role="status"></p>
    </section>`, () => {
      const root = m('#localMarket');
      if (!root) return;
      const get = selector => root.querySelector(selector);
      root.querySelectorAll('[data-tab]').forEach(node => node.onclick = () => open(node.dataset.tab));
      const search = get('#mktSearch');
      if (search) {
        const unit = get('#mktCurrency');
        const sort = get('#mktSort');
        search.value = state.query;
        unit.value = state.currency;
        sort.value = state.sort;
        const filter = () => { state.page = 0; open(); };
        const searchNow = () => { state.query = search.value.trim(); filter(); };
        search.onkeydown = event => { if (event.key === 'Enter') searchNow(); };
        get('#mktFind').onclick = searchNow;
        unit.onchange = () => { state.currency = unit.value; filter(); };
        sort.onchange = () => { state.sort = sort.value; filter(); };
        get('#mktPrev').onclick = () => { state.page--; open(); };
        get('#mktNext').onclick = () => { state.page++; open(); };
      }
      get('#mktReload').onclick = () => void refresh(root);
      void refresh(root);
    });
  }
  return { open, renderInventory };
})();

if (typeof Y0 === 'function') {
  const upstreamMarketPanel = Y0;
  Y0 = function (tab, ...args) {
    if (tab === 'mkt') return localMarket.open();
    return upstreamMarketPanel(tab, ...args);
  };
}
