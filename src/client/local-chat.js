/* Authenticated local world chat. SQLite session is the single source of identity. */
(() => {
  'use strict';
  if (document.getElementById('localChatToggle')) return;
  const css = document.createElement('style');
  css.textContent = `
    #localChatToggle {position:fixed;right:12px;bottom:154px;z-index:90090;border:1px solid #c6a366;background:#2e2618;color:#ffdda2;
      border-radius:50%;width:46px;height:46px;font-size:23px;box-shadow:0 2px 12px #000a;cursor:pointer;touch-action:manipulation}
    #localChatPanel {position:fixed;right:12px;bottom:205px;z-index:90091;width:min(360px,calc(100vw - 24px));height:min(380px,65dvh);
      background:#111b15ee;border:1px solid #b99d61;color:#e9d8b2;box-shadow:0 8px 40px #000c;display:flex;flex-direction:column;border-radius:8px;font:13px/1.4 system-ui,sans-serif}
    #localChatPanel[hidden] {display:none}
    #localChatPanel header {display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#29291e;border-bottom:1px solid #826d40}
    #localChatPanel header button {border:0;background:transparent;color:#f5d8a1;font-size:20px;cursor:pointer}
    #localChatMessages {flex:1;overflow-y:auto;overscroll-behavior:contain;padding:10px;user-select:text;-webkit-user-select:text}
    #localChatMessages .entry {padding:5px 0;border-bottom:1px solid #ffffff0c;overflow-wrap:anywhere}
    #localChatMessages .sender {color:#f4ce75;font-weight:600}
    #localChatMessages .system {color:#d8aa88}
    #localChatPanel form {display:flex;gap:5px;padding:9px;background:#18271d}
    #localChatPanel input {flex:1;min-width:0;font:14px system-ui;background:#0e160f;color:#fff;border:1px solid #88764c;border-radius:4px;padding:10px;user-select:text;-webkit-user-select:text}
    #localChatPanel form button {background:#6c522b;color:#fff3d5;border:1px solid #a48b59;padding:7px 10px;border-radius:4px}
    #localChatState {padding:0 10px 7px;color:#cfbaa0;font-size:11px}
  `;
  document.head.appendChild(css);
  const toggle = document.createElement('button');
  toggle.id = 'localChatToggle';
  toggle.type = 'button';
  toggle.title = 'Chat thế giới';
  toggle.setAttribute('aria-label', 'Mở chat thế giới');
  toggle.textContent = '💬';
  const panel = document.createElement('section');
  panel.id = 'localChatPanel';
  panel.hidden = true;
  panel.innerHTML = '<header><b>🌐 Chat thế giới</b><button type="button" id="localChatClose" aria-label="Đóng">×</button></header><div id="localChatMessages" role="log" aria-live="polite"></div><form id="localChatForm"><input id="localChatInput" maxlength="180" autocomplete="off" placeholder="Nhắn với người chơi…" aria-label="Nội dung chat"><button type="submit">Gửi</button></form><div id="localChatState"></div>';
  document.body.append(toggle, panel);
  const messages = document.getElementById('localChatMessages');
  const input = document.getElementById('localChatInput');
  const state = document.getElementById('localChatState');
  const form = document.getElementById('localChatForm');
  const send = form.querySelector('button');
  let lastSeen = 0;
  let busy = false;
  const api = async (url, options) => {
    const response = await fetch(url, {credentials:'same-origin',cache:'no-store',...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || 'HTTP '+response.status);
    return body;
  };
  async function refresh() {
    if (document.hidden || panel.hidden) return;
    try {
      const data = await api('/api/chat/messages');
      const rows = Array.isArray(data.messages) ? data.messages : [];
      const current = rows.length ? rows[rows.length-1].id : 0;
      if (current !== lastSeen) {
        const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
        messages.replaceChildren();
        for (const row of rows) {
          const line = document.createElement('div'); line.className='entry';
          const name = document.createElement('span'); name.className='sender'; name.textContent=row.username + ': ';
          const body = document.createElement('span'); body.textContent=row.body;
          line.append(name,body); messages.append(line);
        }
        lastSeen = current;
        if (nearBottom || !lastSeen) messages.scrollTop = messages.scrollHeight;
      }
      state.textContent = 'Đã kết nối · Tin nhắn lưu trên máy chủ game';
    } catch (error) { state.textContent = 'Chat lỗi: ' + error.message; }
  }
  function show(visible) {
    panel.hidden=!visible;
    toggle.setAttribute('aria-expanded',String(visible));
    if (visible) { void refresh(); input.focus(); }
  }
  toggle.addEventListener('click',()=>show(panel.hidden));
  document.getElementById('localChatClose').addEventListener('click',()=>show(false));
  async function sendMessage(raw, originInput) {
    if (busy) return;
    const body = String(raw || '').trim();
    if (!body) return;
    busy = true; send.disabled = true;
    try {
      await api('/api/chat/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({body}) });
      originInput.value = '';
      show(true);
      await refresh();
    } catch (error) { state.textContent = 'Gửi lỗi: ' + error.message; show(true); }
    finally { busy = false; send.disabled = false; }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void sendMessage(input.value, input);
  });
  // Existing mobile (u20) and desktop chat inputs used the disabled upstream
  // Supabase chat. Make their Send buttons work with the authenticated server.
  for (const selector of ['#u20in', '#chatIn']) {
    const oldForm = document.querySelector(selector);
    if (!oldForm) continue;
    oldForm.addEventListener('submit', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const oldInput = oldForm.querySelector('input');
      if (oldInput) void sendMessage(oldInput.value, oldInput);
    }, true);
  }
  const oldToggle = document.getElementById('chatBtn');
  if (oldToggle) oldToggle.addEventListener('click', event => {
    event.stopImmediatePropagation();
    show(true);
  }, true);
  setInterval(() => { if (!panel.hidden) void refresh(); }, 4000);
})();
