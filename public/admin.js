const adminCards = document.getElementById('adminCards');
const searchInput = document.getElementById('searchInput');
const logoutBtn = document.getElementById('logoutBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const backupMsg = document.getElementById('backupMsg');
const state = { bots: [] };

boot();

async function boot() {
  const session = await fetch('/admin/api/session', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ ok:false }));
  if (!session.ok) {
    location.href = '/admin/login';
    return;
  }
  await refresh();
  setInterval(refresh, 2000);
  searchInput.addEventListener('input', render);
  logoutBtn.addEventListener('click', logout);
  exportBtn.addEventListener('click', exportAll);
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', handleImportFile);
}

async function refresh() {
  try {
    const res = await fetch('/admin/api/bots', { cache: 'no-store' });
    if (res.status === 401) {
      location.href = '/admin/login';
      return;
    }
    const data = await res.json();
    state.bots = data.bots || [];
    render();
  } catch {
    adminCards.innerHTML = `<div class="empty">Không tải được dữ liệu admin.</div>`;
  }
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const bots = state.bots.filter(bot => !q || [bot.bot, bot.symbol, bot.id, bot.botKey].join(' ').toLowerCase().includes(q));
  if (!bots.length) {
    adminCards.innerHTML = `<div class="empty">Không có bot phù hợp.</div>`;
    return;
  }

  adminCards.innerHTML = bots.map(bot => `
    <div class="bot-card">
      <div class="bot-head">
        <div>
          <div class="bot-name">#${bot.sortIndex || '-'} · ${escapeHtml(bot.bot)}</div>
          <div class="bot-meta">${escapeHtml(bot.symbol)} · ${escapeHtml(bot.botKey)}</div>
        </div>
        <div class="pill small">${escapeHtml(bot.status || 'UNKNOWN')}</div>
      </div>
      <div class="badges">
        <span class="badge ${bot.targetHit ? 'yellow' : 'blue'}">TARGET ${bot.targetHit ? 'DONE' : 'OPEN'}</span>
        <span class="badge ${bot.sigall === 1 ? 'green' : bot.sigall === -1 ? 'red' : ''}">SIG ${signalText(bot.sigall)}</span>
      </div>
      <div class="bot-grid">
        ${metric('Balance', money(bot.balance))}
        ${metric('Equity', money(bot.equity))}
        ${metric('Lãi ngày', coloredMoney(bot.realProfit))}
        ${metric('Floating', coloredMoney(bot.floating))}
        ${metric('DD', `${num(bot.dd)}%`)}
        ${metric('Orders', `${bot.orders || 0}`)}
      </div>
      <div class="bot-foot">
        <div><span class="muted">Action:</span> ${escapeHtml(bot.action || '-')}</div>
        <div style="margin-top:6px"><span class="muted">Hedge:</span> ${escapeHtml(bot.hedge || '-')}</div>
        <div class="admin-actions">
          <button class="btn btn-secondary" data-cmd="time_on" data-bot="${escapeHtml(bot.botKey)}">Resume</button>
          <button class="btn btn-secondary" data-cmd="time_off" data-bot="${escapeHtml(bot.botKey)}">Pause</button>
          <button class="btn btn-danger" data-cmd="close_loss" data-bot="${escapeHtml(bot.botKey)}">Close loss</button>
          <button class="btn btn-secondary" data-cmd="close_buy" data-bot="${escapeHtml(bot.botKey)}">Close buy</button>
          <button class="btn btn-secondary" data-cmd="close_sell" data-bot="${escapeHtml(bot.botKey)}">Close sell</button>
          <button class="btn btn-danger wide" data-cmd="close_all" data-bot="${escapeHtml(bot.botKey)}">Close all</button>
        </div>
        <div style="margin-top:12px" class="muted small">
          ${(bot.commands || []).slice(0,5).map(cmd => `${escapeHtml(cmd.cmd)} · ${escapeHtml(cmd.status)} · ${escapeHtml(shortTime(cmd.createdAt))}`).join('<br>') || 'Chưa có command'}
        </div>
      </div>
    </div>
  `).join('');

  adminCards.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => sendCommand(btn.dataset.bot, btn.dataset.cmd, btn));
  });
}

async function sendCommand(botKey, cmd, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang gửi...';
  try {
    const res = await fetch('/admin/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botKey, cmd })
    });
    const data = await res.json();
    btn.textContent = data.ok ? 'Đã xếp lệnh' : 'Lỗi';
    setTimeout(() => {
      btn.textContent = old;
      btn.disabled = false;
    }, 1200);
    refresh();
  } catch {
    btn.textContent = 'Lỗi mạng';
    setTimeout(() => {
      btn.textContent = old;
      btn.disabled = false;
    }, 1200);
  }
}

async function exportAll() {
  try {
    setBackupMsg('Đang export...', 'muted');
    const res = await fetch('/admin/api/export-all', { cache: 'no-store' });
    if (!res.ok) throw new Error('export_failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ea_mobile_bridge_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setBackupMsg('Đã export JSON all.', 'good');
  } catch {
    setBackupMsg('Export thất bại.', 'bad');
  }
}

async function handleImportFile() {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    setBackupMsg('Đang đọc file import...', 'muted');
    const text = await file.text();
    const backup = JSON.parse(text);
    const res = await fetch('/admin/api/import-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'import_failed');
    setBackupMsg(`Import xong: ${data.bots} bot, ${data.monthsBotFiles} file lịch bot.`, 'good');
    importFile.value = '';
    await refresh();
  } catch (err) {
    setBackupMsg(`Import thất bại: ${err.message || 'Lỗi'}`, 'bad');
  }
}

function setBackupMsg(text, cls) {
  backupMsg.className = `notice ${cls || ''}`;
  backupMsg.textContent = text;
}

async function logout() {
  await fetch('/admin/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/admin/login';
}

function metric(label, value) { return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`; }
function signalText(v) { return v === 1 ? 'BUY' : v === -1 ? 'SELL' : 'WAIT'; }
function money(v) { return num(v).toFixed(2); }
function coloredMoney(v) { const n=num(v); const cls=n>0?'good':n<0?'bad':'muted'; return `<span class="${cls}">${n.toFixed(2)}</span>`; }
function num(v) { return Number(v || 0); }
function shortTime(iso) { return iso ? new Date(iso).toLocaleTimeString('vi-VN') : '-'; }
function escapeHtml(str) { return String(str).replace(/[&<>'"]/g, s => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[s])); }
