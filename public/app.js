const state = { bots: [], summary: null, refreshMs: 2000, selectedBotKey: '', selectedMonth: '', monthCacheKey: '', monthData: null };
const summaryGrid = document.getElementById('summaryGrid');
const botCards = document.getElementById('botCards');
const searchInput = document.getElementById('searchInput');
const botCount = document.getElementById('botCount');
const appName = document.getElementById('appName');
const serverClock = document.getElementById('serverClock');
const monthBotSelect = document.getElementById('monthBotSelect');
const monthPicker = document.getElementById('monthPicker');
const monthStats = document.getElementById('monthStats');
const calendarWrap = document.getElementById('calendarWrap');

init();

async function init() {
  bindTabs();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  state.selectedMonth = defaultMonthValue();
  monthPicker.value = state.selectedMonth;
  await loadMeta();
  await refresh();
  setInterval(refresh, state.refreshMs);
  setInterval(() => {
    serverClock.textContent = new Date().toLocaleTimeString('vi-VN');
  }, 1000);
  searchInput.addEventListener('input', renderBots);
  monthBotSelect.addEventListener('change', async () => {
    state.selectedBotKey = monthBotSelect.value;
    await loadMonthCalendar(true);
  });
  monthPicker.addEventListener('change', async () => {
    state.selectedMonth = monthPicker.value || defaultMonthValue();
    await loadMonthCalendar(true);
  });
}

async function loadMeta() {
  try {
    const res = await fetch('/api/public/meta', { cache: 'no-store' });
    const data = await res.json();
    if (data.appName) appName.textContent = data.appName;
    if (data.refreshMs) state.refreshMs = data.refreshMs;
    if (!state.selectedMonth && data.month) {
      state.selectedMonth = data.month;
      monthPicker.value = data.month;
    }
  } catch {}
}

async function refresh() {
  try {
    const res = await fetch('/api/public/bots', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) return;
    state.bots = data.bots || [];
    state.summary = data.summary || {};
    ensureSelectedBot();
    renderSummary();
    renderBots();
    renderMonthBotOptions();
    await loadMonthCalendar();
  } catch {
    summaryGrid.innerHTML = `<div class="empty">Không tải được dữ liệu.</div>`;
  }
}

function ensureSelectedBot() {
  if (!state.selectedBotKey || !state.bots.some(bot => bot.botKey === state.selectedBotKey)) {
    state.selectedBotKey = state.bots[0]?.botKey || '';
  }
}

function renderSummary() {
  const s = state.summary || {};
  const items = [
    ['Tổng bot', s.totalBots ?? 0, 'Bot đang có dữ liệu'],
    ['Online', s.onlineBots ?? 0, 'Bot cập nhật dưới 15 giây'],
    ['Lãi ngày', money(s.totalDayProfit), 'Tổng realProfit'],
    ['Floating', money(s.totalFloating), 'Tổng floating'],
    ['Paused', s.pausedBots ?? 0, 'Bot đang tạm dừng'],
    ['DD TB', `${num(s.avgDd)}%`, 'Drawdown trung bình']
  ];
  summaryGrid.innerHTML = items.map(([label, value, sub]) => `
    <div class="kpi">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      <div class="kpi-sub">${escapeHtml(sub)}</div>
    </div>
  `).join('');
}

function renderBots() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = state.bots.filter(bot => {
    if (!q) return true;
    return [bot.bot, bot.symbol, bot.id, bot.botKey].join(' ').toLowerCase().includes(q);
  });

  botCount.textContent = `${filtered.length} bot`;
  if (!filtered.length) {
    botCards.innerHTML = `<div class="empty">Chưa có bot nào.</div>`;
    return;
  }

  botCards.innerHTML = filtered.map(bot => {
    const onlineBadge = bot.online ? '<span class="badge green">ONLINE</span>' : '<span class="badge red">OFFLINE</span>';
    const statusBadge = badgeByStatus(bot.status);
    const signal = signalText(bot.sigall);
    const signalClass = bot.sigall === 1 ? 'tag-signal-buy' : bot.sigall === -1 ? 'tag-signal-sell' : 'tag-signal-wait';
    return `
      <div class="bot-card ${state.selectedBotKey === bot.botKey ? 'selected-card' : ''}">
        <div class="bot-head">
          <div>
            <div class="bot-name">#${bot.sortIndex || '-'} · ${escapeHtml(bot.bot)}</div>
            <div class="bot-meta">${escapeHtml(bot.symbol)} · ID ${escapeHtml(bot.id || '-')}</div>
          </div>
          <div class="pill small">${escapeHtml(timeAgo(bot.updatedAt))}</div>
        </div>
        <div class="badges">${onlineBadge}${statusBadge}<span class="badge blue">${escapeHtml(bot.timeMode || 'time')}</span></div>
        <div class="bot-grid">
          ${metric('Balance', money(bot.balance))}
          ${metric('Equity', money(bot.equity))}
          ${metric('Lãi ngày', coloredMoney(bot.realProfit))}
          ${metric('Floating', coloredMoney(bot.floating))}
          ${metric('DD', `${num(bot.dd)}%`)}
          ${metric('Orders', String(bot.orders ?? 0))}
          ${metric('Buy / Sell', `${bot.buy ?? 0} / ${bot.sell ?? 0}`)}
          ${metric('Signal', `<span class="${signalClass}">${signal}</span>`)}
          ${metric('Target', money(bot.target))}
          ${metric('Còn thiếu', money(bot.remain))}
        </div>
        <div class="bot-foot">
          <div><span class="muted">Action:</span> ${escapeHtml(bot.action || '-')}</div>
          <div style="margin-top:6px"><span class="muted">Hedge:</span> ${escapeHtml(bot.hedge || '-')}</div>
          <div style="margin-top:10px"><button class="btn btn-secondary small-btn" data-open-calendar="${escapeHtml(bot.botKey)}">Xem lịch tháng</button></div>
        </div>
      </div>
    `;
  }).join('');

  botCards.querySelectorAll('[data-open-calendar]').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.selectedBotKey = btn.dataset.openCalendar;
      renderMonthBotOptions();
      document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'calendar'));
      document.getElementById('tab-home').classList.add('hidden');
      document.getElementById('tab-bots').classList.add('hidden');
      document.getElementById('tab-calendar').classList.remove('hidden');
      await loadMonthCalendar(true);
    });
  });
}

function renderMonthBotOptions() {
  const options = state.bots.map(bot => `<option value="${escapeHtml(bot.botKey)}" ${bot.botKey === state.selectedBotKey ? 'selected' : ''}>#${bot.sortIndex || '-'} · ${escapeHtml(bot.bot)} · ${escapeHtml(bot.symbol)}</option>`).join('');
  monthBotSelect.innerHTML = options || '<option value="">Chưa có bot</option>';
}

async function loadMonthCalendar(force = false) {
  if (!state.selectedBotKey) {
    monthStats.innerHTML = `<div class="empty">Chưa có bot để hiển thị lịch tháng.</div>`;
    calendarWrap.innerHTML = '';
    return;
  }
  const month = state.selectedMonth || defaultMonthValue();
  const cacheKey = `${state.selectedBotKey}__${month}`;
  if (!force && cacheKey === state.monthCacheKey && state.monthData) {
    renderMonthCalendar();
    return;
  }
  try {
    const res = await fetch(`/api/public/month-calendar?botKey=${encodeURIComponent(state.selectedBotKey)}&month=${encodeURIComponent(month)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) return;
    state.monthData = data;
    state.monthCacheKey = cacheKey;
    renderMonthCalendar();
  } catch {
    monthStats.innerHTML = `<div class="empty">Không tải được lịch tháng.</div>`;
    calendarWrap.innerHTML = '';
  }
}

function renderMonthCalendar() {
  const data = state.monthData;
  if (!data || !data.bot) {
    monthStats.innerHTML = `<div class="empty">Chưa có dữ liệu lịch tháng.</div>`;
    calendarWrap.innerHTML = '';
    return;
  }

  const stats = data.stats || {};
  const bot = data.bot || {};
  monthStats.innerHTML = [
    ['Bot', `#${bot.sortIndex || '-'} · ${bot.bot || '-'}`, bot.symbol || '-'],
    ['Tổng $ tháng', money(stats.profitTotal), `${stats.activeDays || 0} ngày hoạt động`],
    ['DD cao nhất', `${num(stats.maxDd)}%`, `${stats.winDays || 0} ngày xanh / ${stats.lossDays || 0} ngày đỏ`],
    ['Tháng', data.month || '-', 'Tự lưu từ heartbeat của EA']
  ].map(([label, value, sub]) => `
    <div class="kpi compact-kpi">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value small-kpi">${escapeHtml(String(value))}</div>
      <div class="kpi-sub">${escapeHtml(String(sub))}</div>
    </div>
  `).join('');

  calendarWrap.innerHTML = buildCalendarHtml(data.month, data.days || []);
}

function buildCalendarHtml(month, days) {
  const map = new Map((days || []).map(day => [day.dateKey, day]));
  const [year, mon] = String(month || defaultMonthValue()).split('-').map(Number);
  const first = new Date(Date.UTC(year, mon - 1, 1));
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const totalDays = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const weekdayLabels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const cells = [];

  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="calendar-cell empty-cell"></div>');
  for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
    const dateKey = `${year}-${String(mon).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const row = map.get(dateKey);
    const profit = num(row?.realProfit);
    const dd = num(row?.dd);
    const cls = profit > 0 ? 'profit-up' : profit < 0 ? 'profit-down' : row ? 'profit-flat' : 'profit-none';
    cells.push(`
      <div class="calendar-cell ${cls}">
        <div class="calendar-day">${dayNum}</div>
        <div class="calendar-profit">${row ? signedMoney(profit) : '-'}</div>
        <div class="calendar-dd">DD ${row ? `${dd.toFixed(2)}%` : '-'}</div>
      </div>
    `);
  }

  return `
    <div class="calendar-card">
      <div class="calendar-weekdays">${weekdayLabels.map(w => `<div>${w}</div>`).join('')}</div>
      <div class="calendar-grid-month">${cells.join('')}</div>
    </div>
  `;
}

function bindTabs() {
  document.querySelectorAll('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-home').classList.toggle('hidden', tab !== 'home');
      document.getElementById('tab-bots').classList.toggle('hidden', tab !== 'bots');
      document.getElementById('tab-calendar').classList.toggle('hidden', tab !== 'calendar');
      if (tab === 'calendar') loadMonthCalendar(true);
    });
  });
}

function metric(label, value) {
  return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
}
function badgeByStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'RUNNING') return '<span class="badge green">RUNNING</span>';
  if (s === 'PAUSED') return '<span class="badge yellow">PAUSED</span>';
  return `<span class="badge">${escapeHtml(s || 'UNKNOWN')}</span>`;
}
function signalText(v) { return v === 1 ? 'BUY' : v === -1 ? 'SELL' : 'WAIT'; }
function money(v) { return num(v).toFixed(2); }
function signedMoney(v) { const n = num(v); return `${n > 0 ? '+' : ''}${n.toFixed(2)}`; }
function coloredMoney(v) {
  const n = num(v);
  const cls = n > 0 ? 'good' : n < 0 ? 'bad' : 'muted';
  return `<span class="${cls}">${n.toFixed(2)}</span>`;
}
function num(v) { return Number(v || 0); }
function timeAgo(iso) {
  if (!iso) return '-';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
function defaultMonthValue() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, s => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[s]));
}
