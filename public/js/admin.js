/**
 * Painel da cozinha — autenticação por PIN, fila de pedidos e disponibilidade
 * do cardápio. Consome a API administrativa protegida por `ADMIN_PIN`.
 */
import {
  ApiError,
  ORDER_STATUS_META,
  api,
  escapeHtml,
  formatPrice,
  formatTime,
  timeAgo,
} from './api.js';

const PIN_KEY = 'ty.admin.pin';
const SOUND_KEY = 'ty.admin.sound';
const POLL_INTERVAL = 12_000;

const PAYMENT_LABELS = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
const NEXT_ACTION = {
  recebido: { next: 'preparando', label: 'Iniciar preparo' },
  preparando: { next: 'pronto', label: 'Marcar pronto' },
  pronto: { next: 'entregue', label: 'Entregue' },
};

const admin = {
  root: null,
  bound: false,
  mounted: false,
  pin: '',
  tab: 'active',
  orders: [],
  stats: null,
  products: [],
  timer: null,
  sound: readSound(),
  lastActiveIds: new Set(),
  firstLoad: true,
  lastUpdate: null,
  refreshing: false,
  failures: 0,
  onToast: () => {},
};

function readPin() {
  try {
    return sessionStorage.getItem(PIN_KEY) || '';
  } catch {
    return '';
  }
}

function savePin(pin) {
  admin.pin = pin;
  try {
    if (pin) sessionStorage.setItem(PIN_KEY, pin);
    else sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* ignora */
  }
}

function readSound() {
  try {
    return sessionStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveSound(value) {
  admin.sound = value;
  try {
    sessionStorage.setItem(SOUND_KEY, value ? 'on' : 'off');
  } catch {
    /* ignora */
  }
}

function toast(message, options) {
  admin.onToast(message, options);
}

/* --------------------------------------------------------------------------
   Áudio de novo pedido
   -------------------------------------------------------------------------- */

let audioContext = null;

function ensureAudio() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    audioContext = new AudioCtx();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function playNewOrderSound() {
  if (!admin.sound) return;
  try {
    const ctx = ensureAudio();
    if (!ctx) return;
    const start = ctx.currentTime;
    [880, 1174, 1568].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = start + index * 0.13;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.24);
    });
  } catch {
    /* som é um extra; seguimos sem ele */
  }
}

/* --------------------------------------------------------------------------
   Telas
   -------------------------------------------------------------------------- */

function gateHtml(message = '') {
  return `<div class="admin-gate">
    <div class="admin-gate-emoji" aria-hidden="true">👨‍🍳</div>
    <p class="eyebrow" style="justify-content:center">ÁREA RESTRITA</p>
    <h1>Painel da cozinha</h1>
    <p>Digite o PIN da equipe para acompanhar os pedidos e atualizar o cardápio.</p>
    <form id="admin-login" novalidate>
      <label for="admin-pin" class="muted" style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase">PIN de acesso</label>
      <input
        id="admin-pin"
        class="pin-input"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        maxlength="8"
        placeholder="••••"
        aria-describedby="gate-error"
        aria-label="PIN de acesso"
      />
      <p class="gate-error" id="gate-error" role="alert">${escapeHtml(message)}</p>
      <button class="btn btn-primary btn-block" type="submit">Entrar no painel</button>
    </form>
    <p class="field-hint">Demonstração: PIN <strong>2468</strong> — altere em <code>ADMIN_PIN</code>.</p>
  </div>`;
}

function statsHtml() {
  const stats = admin.stats;
  if (!stats) return '';
  return `<div class="stats-grid" id="stats-grid">
    <div class="stat-card">
      <span>Pedidos hoje</span>
      <strong>${stats.ordersToday}</strong>
    </div>
    <div class="stat-card">
      <span>Faturamento</span>
      <strong>${formatPrice(stats.revenueCents)}</strong>
    </div>
    <div class="stat-card">
      <span>Ticket médio</span>
      <strong>${formatPrice(stats.averageTicketCents)}</strong>
    </div>
    <div class="stat-card highlight">
      <span>Em andamento</span>
      <strong>${stats.activeOrders}</strong>
    </div>
  </div>`;
}

function topProductsHtml() {
  const top = admin.stats?.topProducts || [];
  if (top.length === 0) return '';
  return `<div class="top-products" id="top-products">
    <h3>Mais pedidos hoje</h3>
    <ul>
      ${top
        .map(
          (product) => `<li><span aria-hidden="true">${product.emoji}</span><span>${escapeHtml(product.name)}</span><span class="qty">${product.quantity} un</span></li>`,
        )
        .join('')}
    </ul>
  </div>`;
}

function tabsHtml() {
  const activeCount = admin.stats?.activeOrders ?? '—';
  return `<div class="admin-tabs" role="tablist" aria-label="Seções do painel">
    <button class="admin-tab ${admin.tab === 'active' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${admin.tab === 'active'}" data-admin-tab="active">
      Em andamento · ${activeCount}
    </button>
    <button class="admin-tab ${admin.tab === 'history' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${admin.tab === 'history'}" data-admin-tab="history">
      Histórico
    </button>
    <button class="admin-tab ${admin.tab === 'products' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${admin.tab === 'products'}" data-admin-tab="products">
      Cardápio
    </button>
  </div>`;
}

function orderCardHtml(order) {
  const meta = ORDER_STATUS_META[order.status] || ORDER_STATUS_META.recebido;
  const action = NEXT_ACTION[order.status];
  const isFinal = order.status === 'entregue' || order.status === 'cancelado';
  const serviceLabel =
    order.serviceType === 'mesa'
      ? `Mesa <strong>${escapeHtml(order.tableNumber || '—')}</strong>`
      : '<strong>Retirada no balcão</strong>';

  return `<article class="order-card" data-status="${order.status}" data-order-id="${escapeHtml(order.id)}">
    <div class="order-head">
      <div class="order-code">#${escapeHtml(order.code)}<small>${timeAgo(order.createdAt)}</small></div>
      <span class="status-badge status-${order.status}">${meta.badge}</span>
    </div>
    <div class="order-service">
      <span>${serviceLabel}</span>
      <span>${escapeHtml(order.customerName)}</span>
      <span>${PAYMENT_LABELS[order.paymentMethod] || escapeHtml(order.paymentMethod)}</span>
    </div>
    <ul class="order-items">
      ${order.items
        .map(
          (item) => `<li>
            <span class="qty">${item.quantity}×</span>
            <span class="item-name">${escapeHtml(item.name)}
              ${item.notes ? `<span class="item-notes">${escapeHtml(item.notes)}</span>` : ''}
            </span>
            <span class="item-price">${formatPrice(item.unitPriceCents * item.quantity)}</span>
          </li>`,
        )
        .join('')}
    </ul>
    ${order.notes ? `<p class="order-notes">📝 ${escapeHtml(order.notes)}</p>` : ''}
    <div class="order-foot">
      <span class="order-total">${formatPrice(order.totalCents)}</span>
      <div class="order-actions">
        ${
          !isFinal
            ? `<button class="btn btn-ghost btn-sm" type="button" data-order-cancel="${escapeHtml(order.id)}">Cancelar</button>`
            : `<span class="order-time">${formatTime(order.updatedAt)}</span>`
        }
        ${
          action
            ? `<button class="btn btn-primary btn-sm" type="button" data-order-advance="${escapeHtml(order.id)}" data-next="${action.next}">${action.label}</button>`
            : ''
        }
      </div>
    </div>
  </article>`;
}

function ordersEmptyHtml() {
  return `<div class="admin-empty">
    ${
      admin.tab === 'active'
        ? 'Tudo em dia por enquanto. Novos pedidos aparecem aqui automaticamente.'
        : 'Nenhum pedido finalizado ainda.'
    }
  </div>`;
}

function ordersHtml() {
  if (admin.orders.length === 0) return ordersEmptyHtml();
  return admin.orders.map(orderCardHtml).join('');
}

function productsHtml() {
  if (admin.products.length === 0) {
    return '<div class="admin-empty">Carregando cardápio…</div>';
  }
  return `<div class="product-admin-list">
    ${admin.products
      .map(
        (product) => `<div class="product-admin-row">
          <span class="emoji" aria-hidden="true">${product.emoji}</span>
          <div class="product-admin-info">
            <strong>${escapeHtml(product.name)}</strong>
            <span>${escapeHtml(product.categoryName)} · ${formatPrice(product.priceCents)}</span>
          </div>
          <button class="switch" type="button" role="switch" aria-checked="${product.available}" aria-label="${product.available ? 'Marcar como esgotado' : 'Marcar como disponível'}: ${escapeHtml(product.name)}" data-toggle-product="${escapeHtml(product.id)}"></button>
        </div>`,
      )
      .join('')}
  </div>`;
}

function toolbarHtml() {
  const updated = admin.lastUpdate
    ? `Atualizado às ${formatTime(admin.lastUpdate)}`
    : 'Carregando…';
  const label =
    admin.tab === 'active'
      ? `${admin.orders.length} pedido(s) em andamento`
      : admin.tab === 'history'
        ? `${admin.orders.length} pedido(s) finalizado(s)`
        : 'Ative ou desative itens do cardápio';
  return `<div class="admin-toolbar">
    <p>${label}</p>
    <p>${updated}${admin.failures > 0 ? ' · reconectando…' : ''}</p>
  </div>`;
}

function dashboardHtml() {
  return `<header class="admin-head">
    <div>
      <p class="eyebrow"><span class="live-dot"></span> COZINHA · AO VIVO</p>
      <h1>Pedidos de hoje</h1>
      <p>A fila atualiza sozinha a cada 12 segundos.</p>
    </div>
    <div class="admin-actions">
      <button class="icon-button" type="button" data-admin-refresh aria-label="Atualizar agora" title="Atualizar agora">
        <svg class="icon" aria-hidden="true"><use href="#i-refresh"></use></svg>
      </button>
      <button class="icon-button ${admin.sound ? 'is-on' : ''}" type="button" data-admin-sound aria-pressed="${admin.sound}" aria-label="${admin.sound ? 'Desligar som de novos pedidos' : 'Ligar som de novos pedidos'}" title="Som de novos pedidos">
        <svg class="icon" aria-hidden="true"><use href="#i-bell"></use></svg>
      </button>
      <button class="btn btn-ghost btn-sm" type="button" data-admin-logout>Sair</button>
    </div>
  </header>
  ${tabsHtml()}
  <div id="toolbar-region">${toolbarHtml()}</div>
  <div id="admin-list-region">
    ${admin.tab === 'products' ? productsHtml() : `<div class="orders-grid">${ordersHtml()}</div>`}
  </div>
  <h2 class="admin-section-title">Resumo do dia</h2>
  <div id="stats-region">${statsHtml()}</div>
  <div id="top-products-region">${topProductsHtml()}</div>`;
}

function renderDashboard() {
  admin.root.innerHTML = dashboardHtml();
}

function updateRegions() {
  if (!admin.root || !admin.mounted) return;
  const statsRegion = admin.root.querySelector('#stats-region');
  if (statsRegion) statsRegion.innerHTML = statsHtml();
  const topRegion = admin.root.querySelector('#top-products-region');
  if (topRegion) topRegion.innerHTML = topProductsHtml();
  const toolbar = admin.root.querySelector('#toolbar-region');
  if (toolbar) toolbar.innerHTML = toolbarHtml();
  const tabs = admin.root.querySelector('.admin-tabs');
  if (tabs) tabs.outerHTML = tabsHtml();
  const list = admin.root.querySelector('#admin-list-region');
  if (list) {
    list.innerHTML =
      admin.tab === 'products' ? productsHtml() : `<div class="orders-grid">${ordersHtml()}</div>`;
  }
}

/* --------------------------------------------------------------------------
   Dados
   -------------------------------------------------------------------------- */

async function fetchStats() {
  const { stats } = await api('/api/admin/stats', { pin: admin.pin });
  admin.stats = stats;
}

async function fetchOrders(view = admin.tab) {
  const { orders } = await api(`/api/admin/orders?view=${view}&limit=80`, { pin: admin.pin });
  admin.orders = orders;
}

async function fetchProducts() {
  const { products } = await api('/api/admin/products', { pin: admin.pin });
  admin.products = products;
}

async function loadDashboard() {
  admin.root.innerHTML = `<div class="menu-loading"><span class="spinner" aria-hidden="true"></span><p>Abrindo a cozinha…</p></div>`;
  try {
    await Promise.all([fetchStats(), fetchProducts()]);
    admin.orders = [];
    admin.lastActiveIds = new Set();
    admin.firstLoad = true;
    admin.lastUpdate = new Date().toISOString();
    admin.failures = 0;
    await refreshOrders('active', { initial: true });
    renderDashboard();
    admin.firstLoad = false;
    startPolling();
  } catch (error) {
    handleAuthError(error);
  }
}

async function refreshOrders(view, { initial = false } = {}) {
  const { orders } = await api(`/api/admin/orders?view=${view}&limit=80`, { pin: admin.pin });
  admin.orders = orders;

  if (view === 'active') {
    const ids = new Set(orders.map((order) => order.id));
    const newOrders = orders.filter((order) => !admin.lastActiveIds.has(order.id));
    if (!admin.firstLoad && !initial && newOrders.length > 0) {
      playNewOrderSound();
      toast(
        newOrders.length === 1
          ? `Novo pedido #${newOrders[0].code} chegou!`
          : `${newOrders.length} novos pedidos chegaram!`,
        { type: 'info', duration: 5000 },
      );
    }
    admin.lastActiveIds = ids;
  }
}

async function refresh({ forceRender = false } = {}) {
  if (admin.refreshing || !admin.pin) return;
  admin.refreshing = true;
  try {
    const jobs = [fetchStats()];
    if (admin.tab !== 'products') {
      jobs.push(fetchOrders(admin.tab));
    }
    const results = await Promise.all(jobs);
    const orders = admin.tab === 'products' ? null : results[1];

    if (orders) {
      if (admin.tab === 'active') {
        const ids = new Set(orders.map((order) => order.id));
        const newOrders = orders.filter((order) => !admin.lastActiveIds.has(order.id));
        if (newOrders.length > 0 && !admin.firstLoad) {
          playNewOrderSound();
          toast(
            newOrders.length === 1
              ? `Novo pedido #${newOrders[0].code} chegou!`
              : `${newOrders.length} novos pedidos chegaram!`,
            { type: 'info', duration: 5000 },
          );
        }
        admin.lastActiveIds = ids;
      }
      admin.orders = orders;
    }

    admin.firstLoad = false;
    admin.failures = 0;
    admin.lastUpdate = new Date().toISOString();
    if (forceRender || !admin.root.querySelector('.admin-head')) renderDashboard();
    else updateRegions();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleAuthError(error);
      return;
    }
    admin.failures += 1;
    const toolbar = admin.root.querySelector('#toolbar-region');
    if (toolbar) {
      toolbar.innerHTML = toolbarHtml();
    }
  } finally {
    admin.refreshing = false;
  }
}

function startPolling() {
  clearInterval(admin.timer);
  admin.timer = setInterval(() => {
    if (document.hidden || !admin.mounted) return;
    refresh();
  }, POLL_INTERVAL);
}

function stopPolling() {
  clearInterval(admin.timer);
  admin.timer = null;
}

function handleAuthError(error) {
  stopPolling();
  if (error instanceof ApiError && error.status === 401) {
    savePin('');
    renderGate('PIN incorreto ou sessão expirada. Tente novamente.');
  } else {
    admin.root.innerHTML = `<div class="admin-gate">
      <div class="admin-gate-emoji" aria-hidden="true">📡</div>
      <h1>Sem conexão</h1>
      <p>Não foi possível falar com a cozinha agora. Verifique a rede e tente de novo.</p>
      <button class="btn btn-primary btn-block" type="button" data-admin-retry style="margin-top:16px">Tentar novamente</button>
    </div>`;
  }
}

function renderGate(message = '') {
  stopPolling();
  admin.root.innerHTML = gateHtml(message);
  const input = admin.root.querySelector('#admin-pin');
  input?.focus();
}

/* --------------------------------------------------------------------------
   Ações
   -------------------------------------------------------------------------- */

async function login(form) {
  const input = form.querySelector('#admin-pin');
  const errorBox = form.querySelector('#gate-error');
  const button = form.querySelector('button[type="submit"]');
  const pin = input.value.trim();
  if (!pin) {
    errorBox.textContent = 'Digite o PIN da equipe.';
    input.focus();
    return;
  }
  errorBox.textContent = '';
  button.disabled = true;
  button.textContent = 'Entrando…';
  try {
    await api('/api/admin/login', { method: 'POST', body: { pin } });
    ensureAudio();
    savePin(pin);
    admin.firstLoad = true;
    admin.lastActiveIds = new Set();
    await loadDashboard();
  } catch (error) {
    errorBox.textContent =
      error instanceof ApiError ? error.message : 'Não foi possível entrar. Tente novamente.';
    button.disabled = false;
    button.textContent = 'Entrar no painel';
    input.select();
  }
}

async function advanceOrder(id, nextStatus) {
  const order = admin.orders.find((item) => item.id === id);
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      pin: admin.pin,
      body: { status: nextStatus },
    });
    toast(
      nextStatus === 'preparando'
        ? `Pedido #${order?.code || ''} em preparo.`
        : nextStatus === 'pronto'
          ? `Pedido #${order?.code || ''} pronto! Avise o cliente.`
          : `Pedido #${order?.code || ''} entregue.`,
    );
    await refresh({ forceRender: true });
    if (admin.tab === 'active') {
      admin.lastActiveIds = new Set(admin.orders.map((item) => item.id));
    }
  } catch (error) {
    if (error.status === 401) return handleAuthError(error);
    toast(error.message || 'Não foi possível atualizar o pedido.', { type: 'error' });
  }
}

async function cancelOrder(id) {
  const order = admin.orders.find((item) => item.id === id);
  const confirmed = window.confirm(
    `Cancelar o pedido #${order?.code || ''}? Essa ação não pode ser desfeita.`,
  );
  if (!confirmed) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      pin: admin.pin,
      body: { status: 'cancelado' },
    });
    toast(`Pedido #${order?.code || ''} cancelado.`, { type: 'info' });
    await refresh({ forceRender: true });
  } catch (error) {
    if (error.status === 401) return handleAuthError(error);
    toast(error.message || 'Não foi possível cancelar o pedido.', { type: 'error' });
  }
}

async function toggleProduct(id) {
  const product = admin.products.find((item) => item.id === id);
  if (!product) return;
  product.available = !product.available;
  updateRegions();
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      pin: admin.pin,
      body: { available: product.available },
    });
    Object.assign(product, result.product);
    toast(
      product.available
        ? `${product.name} disponível novamente.`
        : `${product.name} marcado como esgotado.`,
      { type: 'info' },
    );
    updateRegions();
  } catch (error) {
    product.available = !product.available;
    updateRegions();
    if (error.status === 401) return handleAuthError(error);
    toast(error.message || 'Não foi possível atualizar o item.', { type: 'error' });
  }
}

async function changeTab(tab) {
  if (admin.tab === tab) return;
  admin.tab = tab;
  admin.orders = [];
  try {
    if (tab === 'products') {
      if (admin.products.length === 0) await fetchProducts();
    } else {
      await fetchOrders(tab);
    }
    renderDashboard();
  } catch (error) {
    if (error.status === 401) return handleAuthError(error);
    toast(error.message || 'Não foi possível carregar a aba.', { type: 'error' });
  }
}

function bindRoot() {
  if (admin.bound) return;
  admin.bound = true;
  admin.root.addEventListener('click', (event) => {
    const target = event.target;
    const tab = target.closest('[data-admin-tab]');
    if (tab) {
      changeTab(tab.dataset.adminTab);
      return;
    }
    if (target.closest('[data-admin-refresh]')) {
      refresh({ forceRender: false });
      return;
    }
    if (target.closest('[data-admin-sound]')) {
      saveSound(!admin.sound);
      const button = admin.root.querySelector('[data-admin-sound]');
      button?.classList.toggle('is-on', admin.sound);
      button?.setAttribute('aria-pressed', String(admin.sound));
      if (admin.sound) {
        playNewOrderSound();
        toast('Som de novos pedidos ligado.', { type: 'info' });
      } else {
        toast('Som de novos pedidos desligado.', { type: 'info' });
      }
      return;
    }
    if (target.closest('[data-admin-logout]')) {
      savePin('');
      stopPolling();
      admin.lastActiveIds = new Set();
      renderGate('');
      toast('Você saiu do painel da cozinha.', { type: 'info' });
      return;
    }
    if (target.closest('[data-admin-retry]')) {
      loadDashboard();
      return;
    }
    const advance = target.closest('[data-order-advance]');
    if (advance) {
      advanceOrder(advance.dataset.orderAdvance, advance.dataset.next);
      return;
    }
    const cancel = target.closest('[data-order-cancel]');
    if (cancel) {
      cancelOrder(cancel.dataset.orderCancel);
      return;
    }
    const toggle = target.closest('[data-toggle-product]');
    if (toggle) {
      toggleProduct(toggle.dataset.toggleProduct);
    }
  });

  admin.root.addEventListener('submit', (event) => {
    if (event.target.id !== 'admin-login') return;
    event.preventDefault();
    login(event.target);
  });
}

/* --------------------------------------------------------------------------
   API pública do módulo
   -------------------------------------------------------------------------- */

export function mountAdmin(container, options = {}) {
  admin.root = container;
  admin.onToast = options.toast || (() => {});
  admin.mounted = true;
  admin.pin = readPin();
  admin.sound = readSound();
  bindRoot();

  if (!admin.pin) {
    renderGate('');
    return;
  }
  loadDashboard();
}

export function unmountAdmin() {
  admin.mounted = false;
  stopPolling();
}
