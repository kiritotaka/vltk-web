'use strict';

const $ = id => document.getElementById(id);
const message = $('message');
const listingRoot = $('listings');
const SUPABASE_URL = 'https://atchexthhvseabeacotj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_0uCQ2M95mnhLMsmki5YeDg_tIPXMLdw';

async function getJson(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

async function loadAccount() {
  try {
    const { user } = await getJson('/api/auth/session');
    $('account').textContent = user ? 'Tài khoản: ' + user.username : 'Bạn chưa đăng nhập. Quay lại game để đăng nhập.';
  } catch {
    $('account').textContent = 'Không thể xác định phiên đăng nhập.';
  }
}

async function loadListings() {
  message.textContent = 'Đang tải danh sách…';
  listingRoot.replaceChildren();
  try {
    const query = $('search').value.trim().slice(0, 60);
    // The marketplace catalog is hosted in our own Supabase project.
    // Public RLS exposes only active listings; all writing is disabled.
    const filter = query ? '&or=' + encodeURIComponent('(item_name.ilike.*' + query.replace(/[,*().%]/g, ' ') + '*,seller_name.ilike.*' + query.replace(/[,*().%]/g, ' ') + '*)') : '';
    const response = await fetch(SUPABASE_URL + '/rest/v1/market_listings?select=id,item_name,seller_name,price,currency,created_at&status=eq.active&order=created_at.desc&limit=50' + filter, {
      cache: 'no-store',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    });
    if (!response.ok) throw new Error('Supabase HTTP ' + response.status);
    const listings = await response.json();
    message.textContent = listings.length ? listings.length + ' món đang bày bán' : 'Chợ chưa có món hàng nào.';
    for (const item of listings) {
      const card = document.createElement('article');
      card.className = 'listing';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.item_name;
      const seller = document.createElement('div');
      seller.className = 'small';
      seller.textContent = 'Người bán: ' + item.seller_name;
      info.append(title, seller);
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = Number(item.price).toLocaleString('vi-VN') + (item.currency === 'knb' ? ' KNB' : ' lượng');
      card.append(info, price);
      listingRoot.append(card);
    }
  } catch (error) {
    message.textContent = 'Không tải được Chợ: ' + (error instanceof Error ? error.message : String(error));
  }
}

$('searchForm').addEventListener('submit', event => { event.preventDefault(); void loadListings(); });
$('refresh').addEventListener('click', () => { void loadListings(); });
void loadAccount();
void loadListings();
