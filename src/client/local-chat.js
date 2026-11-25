/* Adapter: use the game's existing world-chat UI with SQLite-authenticated API.
   No duplicate chat windows and no upstream Supabase Auth dependency. */
(() => {
  'use strict';
  if (typeof H === 'undefined' || typeof ex !== 'function') return;
  ex();
  // The original chat initializer normally disables chat when CHAT_CFG is empty.
  // Prevent that asynchronous startup path from undoing the local adapter.
  $g = async function () {};
  document.body.classList.remove('nochat');
  H.state = 'ok';
  H.subOk = true;
  H.err = '';
  H.chan = 'w';
  const localMessages = new WeakSet();
  // SQLite already authenticates usernames. Its messages lack the Supabase
  // faction metadata expected by the legacy chat filter.
  if (typeof ai === 'function') {
    const filter = ai;
    ai = message => !localMessages.has(message) && filter(message);
  }
  if (typeof Ig === 'function') Ig = () => !!window.localGameAuth?.user;
  let lastSignature = '';
  let fetching = false;
  const request = async (url, options) => {
    const response = await fetch(url, { credentials:'same-origin', cache:'no-store', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status);
    return payload;
  };

  const refresh = async () => {
    if (fetching || document.hidden) return;
    fetching = true;
    try {
      const payload = await request('/api/chat/messages');
      const rows = Array.isArray(payload.messages) ? payload.messages : [];
      const signature = rows.length ? rows[rows.length - 1].id + ':' + rows.length : 'empty';
      if (signature !== lastSignature) {
        lastSignature = signature;
        H.msgs = rows.map(row => {
          const message = {
            id: row.id,
            sys: !row.item,
            ts: row.createdAt,
            name: String(row.username),
            item: row.item,
            msg: row.item ? String(row.body) : String(row.username) + ': ' + String(row.body),
          };
          localMessages.add(message);
          return message;
        });
        if (typeof BA === 'function') BA();
        if (typeof T2 === 'function') T2();
      }
      H.state = 'ok';
      H.err = '';
    } catch (error) {
      H.state = 'err';
      H.err = error.message;
      if (typeof BA === 'function') BA();
    } finally {
      fetching = false;
    }
  };

  // Legacy forms already submit via yl(). Replace only the network transport.
  yl = async function (value) {
    const message = String(value || '').replace(/\s+/g, ' ').trim();
    const attachment = H.chan !== 'p' ? H.att : null;
    if (!message && !attachment) return;
    if (H.chan === 'p') {
      if (typeof am === 'function') return am(message);
      k('Chat tổ đội chưa hoạt động.');
      return;
    }
    try {
      let reference;
      if (attachment) {
        if (typeof y8 !== 'function') throw new Error('Hãy vào game với một nhân vật trước.');
        reference = { character: y8(), uid: attachment.uid };
        if (window.localGameStorage) {
          if (typeof $ === 'function') $();
          await window.localGameStorage.flush();
          if (window.localGameStorage.pending) throw new Error('Hãy đợi lưu trang bị rồi thử lại.');
        }
      }
      await request('/api/chat/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({body:message, ...(reference ? {attachment:reference} : {})}),
      });
      const input = document.getElementById('chatTxt');
      if (input) input.value = '';
      if (attachment && H.att === attachment && typeof lr === 'function') lr(null);
      await refresh();
    } catch (error) {
      k('Chat: ' + error.message);
      const input = document.getElementById('chatTxt');
      if (input) input.value = message;
    }
  };
  // The existing chat launcher remains in place.
  if (typeof na === 'function') {
    na = function (open) {
      H.open = !!open;
      document.getElementById('chatBox')?.classList.toggle('open', !!open);
      if (open) void refresh();
      if (typeof BA === 'function') BA();
    };
  }
  void refresh();
  setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
})();
