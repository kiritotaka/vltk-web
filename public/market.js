'use strict';

const $ = id => document.getElementById(id);
const message = $('message');
const listingRoot = $('listings');

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
    const result = await getJson('/api/market/listings?q=' + encodeURIComponent(query));
    const listings = Array.isArray(result.listings) ? result.listings : [];
    message.textContent = listings.length ? listings.length + ' món đang bày bán' : 'Chợ chưa có món hàng nào.';
    for (const item of listings) {
      const card = document.createElement('article');
      card.className = 'listing';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.name;
      const seller = document.createElement('div');
      seller.className = 'small';
      seller.textContent = 'Người bán: ' + item.seller;
      info.append(title, seller);
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = Number(item.price).toLocaleString('vi-VN') + ' lượng';
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
