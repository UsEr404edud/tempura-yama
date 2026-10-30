import {
  ApiError,
  ORDER_STATUS_META,
  api,
  escapeHtml,
  formatPrice,
  formatTime,
  readStorage,
  removeStorage,
  timeAgo,
  writeStorage,
} from './api.js';
import { mountAdmin, unmountAdmin } from './admin.js';

const CART_KEY = 'ty.cart.v1';
const PROFILE_KEY = 'ty.profile.v1';
const RECENT_KEY = 'ty.recent.v1';
const MENU_CACHE_KEY = 'ty.menu.v1';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const refs = {
  views: {
    menu: $('#view-menu'),
    track: $('#view-track'),
    admin: $('#view-admin'),
  },
  navLinks: $$('[data-nav]'),
  chips: $('#category-chips'),
  sections: $('#menu-sections'),
  featuredSection: $('#featured-section'),
  featuredRail: $('#featured-rail'),
  cartCount: $('#cart-count'),
  topCartButton: $('#top-cart-button'),
  cartBarWrap: $('#cart-bar-wrap'),
  cartBar: $('#cart-bar'),
  cartBarCount: $('#cart-bar-count'),
  cartBarTotal: $('#cart-bar-total'),
  itemDialog: $('#item-dialog'),
  itemDialogBody: $('#item-dialog-body'),
  cartDialog: $('#cart-dialog'),
  cartBody: $('#cart-body'),
  cartFoot: $('#cart-foot'),
  cartTitle: $('#cart-title'),
  cartEyebrow: $('#cart-eyebrow'),
  toast: $('#toast'),
  toastText: $('#toast-text'),
  toastIcon: $('#toast-icon'),
  toastAction: $('#toast-action'),
  offlineBanner: $('#offline-banner'),
  trackContent: $('#track-content'),
  recentSection: $('#recent-section'),
  recentOrders: $('#recent-orders'),
  lookupForm: $('#lookup-form'),
  lookupCode: $('#lookup-code'),
  installButton: $('#install-button'),
  installFooter: $('#install-footer'),
  installDialog: $('#install-dialog'),
  adminContent: $('#admin-content'),
  footerYear: $('#footer-year'),
};

const state = {
  menu: null,
  menuLoadedFromCache: false,
  cart: readStorage(CART_KEY, []),
  activeCategory: 'all',
  cartStep: 'cart',
  dialogProduct: null,
  dialogQty: 1,
  dialogNotes: '',
  deferredPrompt: null,
  route: { name: 'menu' },
  track: { code: null, order: null, signature: '', timer: null, controller: null },
  lastAddedProductId: null,
  submitting: false,
  swRegistration: null,
};

/* --------------------------------------------------------------------------
   Utilidades de interface
   -------------------------------------------------------------------------- */

let toastTimer = null;
let toastActionHandler = null;

function toast(message, options = {}) {
  const { type = 'success', actionLabel = '', action = null, duration = 3200 } = options;
  clearTimeout(toastTimer);
  refs.toastText.textContent = message;
  refs.toastIcon.textContent = type === 'error' ? '!' : type === 'info' ? 'i' : '✓';
  refs.toast.classList.toggle('is-error', type === 'error');
  refs.toast.hidden = false;

  if (toastActionHandler) {
    refs.toastAction.removeEventListener('click', toastActionHandler);
    toastActionHandler = null;
  }
  if (actionLabel && action) {
    refs.toastAction.textContent = actionLabel;
    refs.toastAction.hidden = false;
    toastActionHandler = () => {
      action();
      refs.toast.hidden = true;
    };
    refs.toastAction.addEventListener('click', toastActionHandler);
  } else {
    refs.toastAction.hidden = true;
  }

  toastTimer = setTimeout(() => {
    refs.toast.hidden = true;
  }, duration);
}

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  syncBodyLock();
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  syncBodyLock();
}

function syncBodyLock() {
  const anyOpen = $$('dialog[open]').length > 0;
  document.body.classList.toggle('is-locked', anyOpen);
}

function updateOfflineBanner() {
  refs.offlineBanner.hidden = navigator.onLine;
}

/* --------------------------------------------------------------------------
   Cardápio
   -------------------------------------------------------------------------- */

function allProducts() {
  if (!state.menu) return [];
  return state.menu.categories.flatMap((category) =>
    category.products.map((product) => ({ ...product, categoryId: category.id })),
  );
}

function findProduct(productId) {
  return allProducts().find((product) => product.id === productId) || null;
}

function cartItemCount() {
  return state.cart.reduce((total, item) => total + item.quantity, 0);
}

function cartTotalCents() {
  return state.cart.reduce((total, item) => total + item.priceCents * item.quantity, 0);
}

function persistCart() {
  writeStorage(CART_KEY, state.cart);
}

function syncCartWithMenu() {
  if (!state.menu) return;
  let changed = false;
  for (const item of state.cart) {
    const product = findProduct(item.productId);
    if (!product) {
      if (item.available !== false) {
        item.available = false;
        changed = true;
      }
      continue;
    }
    if (item.available === false) {
      item.available = true;
      changed = true;
    }
    if (item.priceCents !== product.priceCents) {
      item.priceCents = product.priceCents;
      changed = true;
    }
    if (item.name !== product.name) {
      item.name = product.name;
      changed = true;
    }
    if (item.emoji !== product.emoji) {
      item.emoji = product.emoji;
      changed = true;
    }
  }
  if (changed) persistCart();
}

function renderMenu() {
  if (!state.menu) return;
  syncCartWithMenu();
  renderChips();
  renderFeatured();
  renderSections();
  updateCartUI();
}

function renderChips() {
  if (!state.menu) return;
  const categories = state.menu.categories.filter((category) => category.products.length > 0);
  if (state.activeCategory !== 'all' && !categories.some((c) => c.id === state.activeCategory)) {
    state.activeCategory = 'all';
  }
  const total = categories.reduce((sum, category) => sum + category.products.length, 0);
  refs.chips.innerHTML = [
    `<button class="chip ${state.activeCategory === 'all' ? 'is-active' : ''}" type="button" data-category="all">
      Tudo <span class="chip-count">${total}</span>
    </button>`,
    ...categories.map(
      (category) => `<button class="chip ${state.activeCategory === category.id ? 'is-active' : ''}" type="button" data-category="${category.id}">
        ${escapeHtml(category.name)} <span class="chip-count">${category.products.length}</span>
      </button>`,
    ),
  ].join('');
}

function renderFeatured() {
  const featured = state.menu?.featured || [];
  if (featured.length === 0) {
    refs.featuredSection.hidden = true;
    return;
  }
  refs.featuredSection.hidden = false;
  refs.featuredRail.innerHTML = featured
    .map((product) => {
      const category = state.menu.categories.find((cat) => cat.id === product.categoryId);
      return `<button class="featured-card" type="button" data-open-product="${product.id}" aria-label="Ver ${escapeHtml(product.name)}">
        <span>
          <span class="featured-tag"><svg class="icon" aria-hidden="true"><use href="#i-flame"></use></svg> Mais pedido</span>
          <span class="featured-emoji" aria-hidden="true">${product.emoji}</span>
          <span class="featured-name">${escapeHtml(product.name)}</span>
        </span>
        <span class="featured-price">
          ${formatPrice(product.priceCents)}
          <span class="meta-pill">${escapeHtml(category?.name || '')}</span>
        </span>
      </button>`;
    })
    .join('');
}

function productCard(product, categoryId) {
  const soldOut = !product.available;
  return `<article class="product-card${soldOut ? ' is-soldout' : ''}" data-product-card="${product.id}">
    <button class="product-open" type="button" data-open-product="${product.id}" ${soldOut ? 'disabled' : ''} aria-label="Ver detalhes de ${escapeHtml(product.name)}">
      <span class="product-thumb" data-cat="${categoryId}" aria-hidden="true">${product.emoji}</span>
      <span class="product-body">
        <span class="product-title">${escapeHtml(product.name)}</span>
        <span class="product-desc">${escapeHtml(product.description)}</span>
        <span class="product-meta">
          <span class="price">${formatPrice(product.priceCents)}</span>
          <span class="prep"><svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg> ${product.prepMinutes} min</span>
        </span>
        ${soldOut ? '<span class="soldout-tag">Esgotado hoje</span>' : ''}
      </span>
    </button>
    ${
      soldOut
        ? ''
        : `<button class="add-btn" type="button" data-add-product="${product.id}" aria-label="Adicionar ${escapeHtml(product.name)} ao pedido">
            <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
          </button>`
    }
  </article>`;
}

function renderSections() {
  if (!state.menu) return;
  const categories = state.menu.categories.filter((category) =>
    state.activeCategory === 'all' ? true : category.id === state.activeCategory,
  );

  refs.sections.innerHTML = categories
    .map(
      (category) => `<section class="menu-section" id="cat-${category.id}" aria-labelledby="cat-title-${category.id}">
        <header class="menu-section-head">
          <div>
            <h2 id="cat-title-${category.id}">${escapeHtml(category.name)}</h2>
            <p>${escapeHtml(category.tagline || '')}</p>
          </div>
          <span class="menu-section-count">${category.products.length} itens</span>
        </header>
        <div class="product-grid">
          ${category.products.map((product) => productCard(product, category.id)).join('')}
        </div>
      </section>`,
    )
    .join('');

  if (categories.length === 0) {
    refs.sections.innerHTML = `<div class="empty-state">
      <span class="empty-emoji" aria-hidden="true">🍤</span>
      <h3>Nada por aqui ainda</h3>
      <p>Estamos atualizando o cardápio. Tente novamente em instantes.</p>
    </div>`;
  }
}

async function loadMenu({ silent = false } = {}) {
  const cached = readStorage(MENU_CACHE_KEY, null);
  if (cached?.categories?.length && !state.menu) {
    state.menu = cached;
    state.menuLoadedFromCache = true;
    renderMenu();
  }

  try {
    const menu = await api('/api/menu');
    state.menu = menu;
    state.menuLoadedFromCache = false;
    writeStorage(MENU_CACHE_KEY, menu);
    renderMenu();
    updateOfflineBanner();
    if (!navigator.onLine) {
      refs.offlineBanner.hidden = false;
    }
  } catch (error) {
    updateOfflineBanner();
    if (!state.menu) {
      refs.sections.innerHTML = `<div class="empty-state">
        <span class="empty-emoji" aria-hidden="true">📡</span>
        <h3>Não conseguimos carregar o cardápio</h3>
        <p>Confira sua conexão e tente novamente.</p>
        <button class="btn btn-primary" type="button" data-retry-menu>Recarregar</button>
      </div>`;
    } else if (!silent) {
      toast('Cardápio offline: mostrando a última versão salva.', { type: 'info' });
    }
    if (!(error instanceof ApiError)) console.error(error);
  }
}

/* --------------------------------------------------------------------------
   Carrinho
   -------------------------------------------------------------------------- */

function updateCartUI() {
  const count = cartItemCount();
  const total = cartTotalCents();
  refs.cartCount.textContent = String(count);
  refs.cartCount.dataset.empty = count === 0 ? 'true' : 'false';
  refs.cartBarCount.textContent = String(count);
  refs.cartBarTotal.textContent = formatPrice(total);
  refs.cartBarWrap.hidden = count === 0 || state.route?.name === 'admin';
  refs.topCartButton.setAttribute(
    'aria-label',
    count === 0 ? 'Abrir meu pedido (vazio)' : `Abrir meu pedido, ${count} itens, ${formatPrice(total)}`,
  );

  if (refs.cartDialog.open) {
    renderCartStep();
  }
}

function syncCartBarVisibility() {
  refs.cartBarWrap.hidden = cartItemCount() === 0 || state.route?.name === 'admin';
}

function bumpCartBadge() {
  refs.cartCount.classList.remove('bump');
  void refs.cartCount.offsetWidth;
  refs.cartCount.classList.add('bump');
}

function addToCart(product, quantity, notes) {
  const cleanNotes = (notes || '').trim().slice(0, 120);
  const existing = state.cart.find(
    (item) => item.productId === product.id && (item.notes || '') === cleanNotes,
  );

  if (existing) {
    existing.quantity = Math.min(20, existing.quantity + quantity);
  } else {
    state.cart.push({
      productId: product.id,
      name: product.name,
      emoji: product.emoji,
      priceCents: product.priceCents,
      quantity,
      notes: cleanNotes,
      available: product.available,
    });
  }
  persistCart();
  updateCartUI();
  bumpCartBadge();
  toast(`${quantity}× ${product.name} no pedido`, {
    actionLabel: 'Ver pedido',
    action: () => openCart(),
  });
}

function changeQuantity(productId, notes, delta) {
  const index = state.cart.findIndex(
    (item) => item.productId === productId && (item.notes || '') === (notes || ''),
  );
  if (index === -1) return;
  const item = state.cart[index];
  item.quantity += delta;
  if (item.quantity <= 0) {
    state.cart.splice(index, 1);
    toast(`${item.name} removido do pedido`, { type: 'info' });
  }
  persistCart();
  updateCartUI();
}

function removeCartItem(productId, notes) {
  const before = state.cart.length;
  state.cart = state.cart.filter(
    (item) => !(item.productId === productId && (item.notes || '') === (notes || '')),
  );
  if (state.cart.length !== before) {
    persistCart();
    updateCartUI();
    renderCartStep();
    toast('Item removido do pedido', { type: 'info' });
  }
}

function openCart() {
  state.cartStep = 'cart';
  renderCartStep();
  openDialog(refs.cartDialog);
}

function cartItemsHtml() {
  return `<ul class="cart-list">
    ${state.cart
      .map((item) => {
        const unavailable = item.available === false;
        return `<li class="cart-item${unavailable ? ' is-unavailable' : ''}">
          <span class="cart-item-emoji" aria-hidden="true">${item.emoji}</span>
          <div class="cart-item-info">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="cart-item-price">${formatPrice(item.priceCents)} cada</span>
            ${item.notes ? `<span class="cart-item-note">“${escapeHtml(item.notes)}”</span>` : ''}
            ${unavailable ? '<span class="unavailable-tag">Esgotado — remova para continuar</span>' : ''}
          </div>
          <button class="cart-item-remove" type="button" data-cart-remove="${item.productId}" data-notes="${escapeHtml(item.notes || '')}" aria-label="Remover ${escapeHtml(item.name)}">
            <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
          </button>
          <div class="stepper" role="group" aria-label="Quantidade de ${escapeHtml(item.name)}">
            <button type="button" data-cart-dec="${item.productId}" data-notes="${escapeHtml(item.notes || '')}" aria-label="Diminuir quantidade">
              <svg class="icon" aria-hidden="true"><use href="#i-minus"></use></svg>
            </button>
            <span class="value">${item.quantity}</span>
            <button type="button" data-cart-inc="${item.productId}" data-notes="${escapeHtml(item.notes || '')}" aria-label="Aumentar quantidade" ${item.quantity >= 20 ? 'disabled' : ''}>
              <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
            </button>
          </div>
        </li>`;
      })
      .join('')}
  </ul>`;
}

function renderCartStep() {
  refs.cartTitle.textContent = state.cartStep === 'checkout' ? 'Finalizar pedido' : 'Carrinho';
  refs.cartEyebrow.textContent = state.cartStep === 'checkout' ? 'QUASE LÁ' : 'SEU PEDIDO';

  if (state.cart.length === 0) {
    refs.cartBody.innerHTML = `<div class="cart-empty">
      <span class="empty-emoji" aria-hidden="true">🍤</span>
      <h3>Seu pedido está vazio</h3>
      <p>Escolha um tempurá no cardápio. A gente frita na hora e avisa quando estiver pronto.</p>
      <button class="btn btn-primary" type="button" data-action="close-cart">Ver cardápio</button>
    </div>`;
    refs.cartFoot.innerHTML = '';
    return;
  }

  if (state.cartStep === 'checkout') {
    renderCheckout();
    return;
  }

  const hasUnavailable = state.cart.some((item) => item.available === false);
  const total = cartTotalCents();

  refs.cartBody.innerHTML = `
    ${cartItemsHtml()}
    <div class="cart-summary">
      <div class="cart-summary-row"><span>Subtotal</span><span>${formatPrice(total)}</span></div>
      <div class="cart-summary-row"><span>Total</span><strong>${formatPrice(total)}</strong></div>
      <p class="cart-hint">Sem taxa de serviço. O pagamento é feito na mesa ou no balcão.</p>
    </div>`;

  refs.cartFoot.innerHTML = `
    <div class="cart-foot-row">
      <span class="cart-foot-total">Total<strong>${formatPrice(total)}</strong></span>
      <button class="btn btn-primary" type="button" data-action="go-checkout" ${hasUnavailable ? 'disabled' : ''}>
        Continuar
        <svg class="icon" aria-hidden="true"><use href="#i-arrow"></use></svg>
      </button>
    </div>
    ${hasUnavailable ? '<p class="field-error" style="margin-top:8px">Remova os itens esgotados para continuar.</p>' : ''}`;
}

function checkoutFormHtml() {
  const profile = readStorage(PROFILE_KEY, {});
  const serviceType = profile.serviceType || 'mesa';
  const payment = profile.paymentMethod || 'pix';
  const total = cartTotalCents();

  return `<form id="checkout-form" class="checkout-form" novalidate>
    <fieldset class="field-group">
      <legend>Como você vai receber?</legend>
      <div class="segmented">
        <label class="segment">
          <input type="radio" name="serviceType" value="mesa" ${serviceType === 'mesa' ? 'checked' : ''} />
          <span><svg class="icon" aria-hidden="true"><use href="#i-table"></use></svg> Na mesa</span>
        </label>
        <label class="segment">
          <input type="radio" name="serviceType" value="balcao" ${serviceType === 'balcao' ? 'checked' : ''} />
          <span><svg class="icon" aria-hidden="true"><use href="#i-bag"></use></svg> No balcão</span>
        </label>
      </div>
    </fieldset>

    <div class="field" id="table-field" ${serviceType === 'balcao' ? 'hidden' : ''}>
      <label for="table-number">Número da mesa</label>
      <input id="table-number" name="tableNumber" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3"
        placeholder="Ex.: 12" value="${escapeHtml(profile.tableNumber || '')}" autocomplete="off" />
      <span class="field-error" id="table-error"></span>
    </div>

    <div class="field">
      <label for="customer-name">Seu nome</label>
      <input id="customer-name" name="customerName" type="text" maxlength="60" autocomplete="name"
        placeholder="Como podemos chamar você?" value="${escapeHtml(profile.customerName || '')}" />
      <span class="field-error" id="name-error"></span>
    </div>

    <fieldset class="field-group">
      <legend>Pagamento</legend>
      <div class="segmented three">
        <label class="segment">
          <input type="radio" name="paymentMethod" value="pix" ${payment === 'pix' ? 'checked' : ''} />
          <span>Pix</span>
        </label>
        <label class="segment">
          <input type="radio" name="paymentMethod" value="cartao" ${payment === 'cartao' ? 'checked' : ''} />
          <span>Cartão</span>
        </label>
        <label class="segment">
          <input type="radio" name="paymentMethod" value="dinheiro" ${payment === 'dinheiro' ? 'checked' : ''} />
          <span>Dinheiro</span>
        </label>
      </div>
    </fieldset>

    <div class="field">
      <label for="order-notes">Observações (opcional)</label>
      <textarea id="order-notes" name="notes" maxlength="180" placeholder="Alergias, preferências, ponto da fritura…"></textarea>
    </div>

    <div class="checkout-review" aria-label="Resumo do pedido">
      <ul>
        ${state.cart
          .map(
            (item) => `<li><span class="review-name">${item.quantity}× ${escapeHtml(item.name)}</span><span class="review-price">${formatPrice(item.priceCents * item.quantity)}</span></li>`,
          )
          .join('')}
      </ul>
      <div class="review-total"><span>Total</span><span>${formatPrice(total)}</span></div>
    </div>
    <div id="checkout-error"></div>
  </form>`;
}

function renderCheckout() {
  refs.cartBody.innerHTML = checkoutFormHtml();
  refs.cartFoot.innerHTML = `
    <div class="cart-foot-row">
      <button class="btn btn-ghost" type="button" data-action="back-to-cart">
        <svg class="icon" aria-hidden="true"><use href="#i-arrow" style="transform:rotate(180deg)"></use></svg>
        Voltar
      </button>
      <button class="btn btn-primary" type="submit" form="checkout-form" id="confirm-order">
        Confirmar pedido
      </button>
    </div>`;
}

async function submitOrder(form) {
  if (state.submitting) return;
  const formData = new FormData(form);
  const customerName = String(formData.get('customerName') || '').trim();
  const serviceType = String(formData.get('serviceType') || 'mesa');
  const tableNumber = String(formData.get('tableNumber') || '').trim();
  const paymentMethod = String(formData.get('paymentMethod') || 'pix');
  const notes = String(formData.get('notes') || '').trim();

  const nameError = $('#name-error');
  const tableError = $('#table-error');
  nameError.textContent = '';
  tableError.textContent = '';

  let firstInvalid = null;
  if (customerName.length < 2) {
    nameError.textContent = 'Informe pelo menos 2 letras.';
    firstInvalid = $('#customer-name');
  }
  if (serviceType === 'mesa' && (!/^\d{1,3}$/.test(tableNumber) || Number(tableNumber) < 1)) {
    tableError.textContent = 'Informe um número de mesa válido.';
    firstInvalid = firstInvalid || $('#table-number');
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  const errorBox = $('#checkout-error');
  errorBox.innerHTML = '';
  state.submitting = true;
  const submitButton = $('#confirm-order');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Enviando pedido…';
  }

  try {
    const { order } = await api('/api/orders', {
      method: 'POST',
      body: {
        customerName,
        serviceType,
        tableNumber: serviceType === 'mesa' ? tableNumber : undefined,
        paymentMethod,
        notes: notes || undefined,
        items: state.cart.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          notes: item.notes || undefined,
        })),
      },
    });

    writeStorage(PROFILE_KEY, { customerName, serviceType, tableNumber, paymentMethod });
    addRecentOrder(order);
    state.cart = [];
    persistCart();
    updateCartUI();
    closeDialog(refs.cartDialog);
    toast(`Pedido ${order.code} confirmado. Bom apetite!`);
    location.hash = `#/pedido/${order.code}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : 'Não foi possível enviar o pedido. Tente novamente.';
    errorBox.innerHTML = `<p class="form-error" role="alert">${escapeHtml(message)}</p>`;
    if (error.code === 'PRODUCT_UNAVAILABLE' || error.code === 'PRODUCT_NOT_FOUND') {
      await loadMenu({ silent: true });
      syncCartWithMenu();
      renderCartStep();
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Confirmar pedido';
    }
  } finally {
    state.submitting = false;
  }
}

/* --------------------------------------------------------------------------
   Modal de item
   -------------------------------------------------------------------------- */

function renderItemDialog() {
  const product = state.dialogProduct;
  if (!product) return;
  const total = product.priceCents * state.dialogQty;
  refs.itemDialogBody.innerHTML = `
    <div class="item-detail-top">
      <span class="item-detail-thumb" aria-hidden="true">${product.emoji}</span>
      <div>
        <h2 id="item-dialog-title">${escapeHtml(product.name)}</h2>
        <span class="price">${formatPrice(product.priceCents)}</span>
      </div>
    </div>
    <p class="item-detail-desc">${escapeHtml(product.description)}</p>
    <div class="item-detail-meta">
      <span class="meta-pill"><svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg> ~${product.prepMinutes} min</span>
      <span class="meta-pill"><svg class="icon" aria-hidden="true"><use href="#i-flame"></use></svg> frito na hora</span>
      <span class="meta-pill"><svg class="icon" aria-hidden="true"><use href="#i-dish"></use></svg> serve 1</span>
    </div>
    <div class="item-order-box">
      <div class="qty-row">
        <span class="label">Quantidade</span>
        <div class="stepper" role="group" aria-label="Quantidade">
          <button type="button" data-item-step="-1" aria-label="Diminuir quantidade" ${state.dialogQty <= 1 ? 'disabled' : ''}>
            <svg class="icon" aria-hidden="true"><use href="#i-minus"></use></svg>
          </button>
          <span class="value" id="item-qty-value">${state.dialogQty}</span>
          <button type="button" data-item-step="1" aria-label="Aumentar quantidade" ${state.dialogQty >= 20 ? 'disabled' : ''}>
            <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
          </button>
        </div>
      </div>
      <div class="item-notes">
        <label for="item-notes-input">Alguma observação?</label>
        <textarea id="item-notes-input" maxlength="120" placeholder="Ex.: sem molho, bem crocante, sem cebolinha…">${escapeHtml(state.dialogNotes)}</textarea>
      </div>
      <button class="item-add" type="button" data-item-add>
        <span>Adicionar ao pedido</span>
        <span class="total" id="item-add-total">${formatPrice(total)}</span>
      </button>
    </div>`;
}

function openItem(productId) {
  const product = findProduct(productId);
  if (!product) return;
  if (!product.available) {
    toast('Este item está esgotado hoje.', { type: 'error' });
    return;
  }
  state.dialogProduct = product;
  state.dialogQty = 1;
  state.dialogNotes = '';
  renderItemDialog();
  openDialog(refs.itemDialog);
}

/* --------------------------------------------------------------------------
   Acompanhamento do pedido
   -------------------------------------------------------------------------- */

function getRecentOrders() {
  return readStorage(RECENT_KEY, []);
}

function addRecentOrder(order) {
  const recent = getRecentOrders().filter((item) => item.code !== order.code);
  recent.unshift({
    code: order.code,
    createdAt: order.createdAt,
    totalCents: order.totalCents,
    status: order.status,
  });
  writeStorage(RECENT_KEY, recent.slice(0, 6));
  renderRecentOrders();
}

function updateRecentStatus(code, status) {
  const recent = getRecentOrders();
  const item = recent.find((entry) => entry.code === code);
  if (item && item.status !== status) {
    item.status = status;
    writeStorage(RECENT_KEY, recent);
    renderRecentOrders();
  }
}

function renderRecentOrders() {
  const recent = getRecentOrders();
  if (recent.length === 0) {
    refs.recentSection.hidden = true;
    return;
  }
  refs.recentSection.hidden = false;
  refs.recentOrders.innerHTML = recent
    .map((order) => {
      const meta = ORDER_STATUS_META[order.status] || ORDER_STATUS_META.recebido;
      return `<a class="recent-item" href="#/pedido/${encodeURIComponent(order.code)}">
        <span class="recent-code">${escapeHtml(order.code)}</span>
        <span class="recent-meta">
          <span class="status-badge status-${order.status}" style="margin-right:6px">${meta.badge}</span>
          ${formatPrice(order.totalCents)} · ${timeAgo(order.createdAt)}
        </span>
        <svg class="icon" aria-hidden="true"><use href="#i-arrow"></use></svg>
      </a>`;
    })
    .join('');
}

function estimateReadyTime(order) {
  const created = new Date(order.createdAt);
  const prepMinutes = Math.max(8, Math.min(18, order.items.length * 3 + 6));
  return new Date(created.getTime() + prepMinutes * 60_000);
}

function trackCardHtml(order) {
  const meta = ORDER_STATUS_META[order.status] || ORDER_STATUS_META.recebido;
  const steps = ['recebido', 'preparando', 'pronto', 'entregue'];
  const cancelled = order.status === 'cancelado';
  const currentIndex = steps.indexOf(order.status);
  const isFinal = order.status === 'entregue' || cancelled;
  const paymentLabels = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
  const serviceLabel =
    order.serviceType === 'mesa'
      ? `Mesa ${escapeHtml(order.tableNumber || '—')}`
      : 'Retirada no balcão';

  const etaText = cancelled
    ? `Cancelado às ${formatTime(order.updatedAt)}`
    : order.status === 'entregue'
      ? `Entregue às ${formatTime(order.updatedAt)}`
      : `Previsão: ${formatTime(estimateReadyTime(order))}`;

  return `<article class="track-card">
    <header class="track-top">
      <div>
        <p class="eyebrow">PEDIDO</p>
        <div class="track-code">${escapeHtml(order.code)}<small>${escapeHtml(order.customerName)}</small></div>
      </div>
      <span class="status-badge status-${order.status}">${meta.badge}</span>
    </header>

    <div class="track-eta">
      <span><svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg> ${etaText}</span>
      <span><svg class="icon" aria-hidden="true"><use href="#i-table"></use></svg> ${serviceLabel}</span>
      <span><svg class="icon" aria-hidden="true"><use href="#i-card"></use></svg> ${paymentLabels[order.paymentMethod] || order.paymentMethod}</span>
      <span class="track-live" data-live-indicator>${isFinal ? 'finalizado' : 'atualiza sozinho'}</span>
    </div>

    ${
      cancelled
        ? `<p class="track-note">Este pedido foi cancelado. Se precisar de ajuda, fale com a equipe no balcão.</p>`
        : `<ol class="timeline">
            ${steps
              .map((step, index) => {
                const stepMeta = ORDER_STATUS_META[step];
                const done = currentIndex > index;
                const current = currentIndex === index;
                return `<li class="timeline-step ${done ? 'is-done' : ''} ${current ? 'is-current' : ''}">
                  <span class="timeline-marker" aria-hidden="true">${done ? '✓' : index + 1}</span>
                  <span class="timeline-label">
                    <strong>${stepMeta.title}</strong>
                    <span>${stepMeta.description}</span>
                  </span>
                </li>`;
              })
              .join('')}
          </ol>`
    }

    <div class="track-items">
      ${order.items
        .map(
          (item) => `<div class="track-item">
            <span class="track-item-emoji" aria-hidden="true">${item.emoji || '🍤'}</span>
            <span class="track-item-name">${item.quantity}× ${escapeHtml(item.name)}
              ${item.notes ? `<small>“${escapeHtml(item.notes)}”</small>` : ''}
            </span>
            <span class="track-item-price">${formatPrice(item.unitPriceCents * item.quantity)}</span>
          </div>`,
        )
        .join('')}
    </div>

    <div class="track-total">
      <div>
        <small>Total do pedido</small>
        <strong>${formatPrice(order.totalCents)}</strong>
      </div>
      <span class="track-live">pedido feito às ${formatTime(order.createdAt)}</span>
    </div>

    ${order.notes ? `<p class="track-note">📝 ${escapeHtml(order.notes)}</p>` : ''}
  </article>`;
}

function emptyTrackHtml(message = 'Digite o código do pedido para acompanhar o preparo.') {
  return `<div class="empty-state">
    <span class="empty-emoji" aria-hidden="true">🧾</span>
    <h3>Nenhum pedido em exibição</h3>
    <p>${escapeHtml(message)}</p>
  </div>`;
}

async function fetchOrder(code) {
  const controller = new AbortController();
  state.track.controller?.abort();
  state.track.controller = controller;
  return api(`/api/orders/${encodeURIComponent(code)}`, { signal: controller.signal });
}

async function renderTrack(code) {
  clearTimeout(state.track.timer);
  state.track.timer = null;
  state.track.code = code || null;
  state.track.order = null;
  state.track.signature = '';

  if (!code) {
    refs.trackContent.innerHTML = emptyTrackHtml();
    renderRecentOrders();
    return;
  }

  refs.trackContent.innerHTML = `<div class="menu-loading"><span class="spinner" aria-hidden="true"></span><p>Buscando seu pedido…</p></div>`;

  try {
    const { order } = await fetchOrder(code);
    state.track.order = order;
    state.track.signature = `${order.status}:${order.updatedAt}`;
    refs.trackContent.innerHTML = trackCardHtml(order);
    updateRecentStatus(order.code, order.status);
    scheduleTrackPoll();
  } catch (error) {
    if (error.name === 'AbortError') return;
    refs.trackContent.innerHTML = emptyTrackHtml(
      error.status === 404
        ? 'Não encontramos esse código. Confira no comprovante e tente de novo.'
        : 'Não foi possível consultar o pedido agora. Verifique sua conexão.',
    );
  }
}

function scheduleTrackPoll() {
  clearTimeout(state.track.timer);
  const order = state.track.order;
  if (!order) return;
  if (order.status === 'entregue' || order.status === 'cancelado') return;

  state.track.timer = setTimeout(async () => {
    if (document.hidden || state.route.name !== 'track' || !state.track.code) return;
    try {
      const { order: fresh } = await fetchOrder(state.track.code);
      const signature = `${fresh.status}:${fresh.updatedAt}`;
      if (signature !== state.track.signature) {
        state.track.order = fresh;
        state.track.signature = signature;
        refs.trackContent.innerHTML = trackCardHtml(fresh);
        updateRecentStatus(fresh.code, fresh.status);
        if (fresh.status === 'pronto') {
          toast('Seu pedido está pronto! 🍤', { duration: 5000 });
        }
      }
      scheduleTrackPoll();
    } catch {
      scheduleTrackPoll();
    }
  }, 9000);
}

/* --------------------------------------------------------------------------
   Rotas e navegação
   -------------------------------------------------------------------------- */

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash || hash === '/' || hash === 'cardapio') return { name: 'menu' };
  if (hash.startsWith('/pedido')) {
    const [, , code] = hash.split('/');
    return { name: 'track', code: code ? decodeURIComponent(code).toUpperCase() : null };
  }
  if (hash.startsWith('/admin')) return { name: 'admin' };
  return { name: 'menu' };
}

function setActiveNav(name) {
  for (const link of refs.navLinks) {
    const isActive = link.dataset.nav === name;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function showView(name) {
  for (const [key, view] of Object.entries(refs.views)) {
    view.hidden = key !== name;
  }
}

function handleRoute() {
  const route = parseRoute();
  state.route = route;
  clearTimeout(state.track.timer);
  state.track.timer = null;

  if (state.route.name !== 'admin') {
    unmountAdmin();
  }

  showView(route.name);
  setActiveNav(route.name === 'menu' ? 'menu' : route.name);
  document.body.dataset.view = route.name;
  syncCartBarVisibility();
  updateOfflineBanner();

  if (route.name === 'menu') {
    if (!state.menu) loadMenu();
    if (location.hash === '#cardapio') {
      setTimeout(() => {
        $('#menu-sticky')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  } else if (route.name === 'track') {
    if (route.code) refs.lookupCode.value = route.code;
    renderTrack(route.code);
  } else if (route.name === 'admin') {
    mountAdmin(refs.adminContent, { toast });
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* --------------------------------------------------------------------------
   PWA: instalação e service worker
   -------------------------------------------------------------------------- */

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function updateInstallButtons() {
  const canInstall = Boolean(state.deferredPrompt);
  refs.installButton.hidden = !canInstall || isStandalone();
  refs.installFooter.hidden = isStandalone();
}

async function promptInstall() {
  if (state.deferredPrompt) {
    const promptEvent = state.deferredPrompt;
    state.deferredPrompt = null;
    updateInstallButtons();
    promptEvent.prompt();
    const choice = await promptEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (choice.outcome === 'accepted') {
      toast('Instalando o Tempura Yama no seu dispositivo…', { type: 'info' });
    }
    return;
  }
  openDialog(refs.installDialog);
}

function setupPwa() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    updateInstallButtons();
  });

  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null;
    updateInstallButtons();
    closeDialog(refs.installDialog);
    toast('Aplicativo instalado. Até logo!', { duration: 4000 });
  });

  refs.installButton.addEventListener('click', promptInstall);
  refs.installFooter.addEventListener('click', promptInstall);

  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isiOS && !isStandalone()) refs.installFooter.hidden = false;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        state.swRegistration = registration;

        const offerUpdate = (worker) => {
          toast('Nova versão do totem disponível.', {
            type: 'info',
            actionLabel: 'Atualizar',
            duration: 12_000,
            action: () => {
              worker.postMessage({ type: 'SKIP_WAITING' });
            },
          });
        };

        if (registration.waiting) offerUpdate(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              offerUpdate(newWorker);
            }
          });
        });

        let refreshed = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshed) return;
          refreshed = true;
          window.location.reload();
        });
      } catch (error) {
        console.warn('[pwa] não foi possível registrar o service worker:', error);
      }
    });
  }
}

/* --------------------------------------------------------------------------
   Eventos globais
   -------------------------------------------------------------------------- */

function bindEvents() {
  // Navegação por categorias
  refs.chips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-category]');
    if (!chip) return;
    state.activeCategory = chip.dataset.category;
    renderChips();
    renderSections();
    const activeChip = refs.chips.querySelector('.chip.is-active');
    activeChip?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });

  // Cliques no cardápio
  refs.sections.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-add-product]');
    if (addButton) {
      const product = findProduct(addButton.dataset.addProduct);
      if (product) addToCart(product, 1, '');
      return;
    }
    const openButton = event.target.closest('[data-open-product]');
    if (openButton) openItem(openButton.dataset.openProduct);
    const retry = event.target.closest('[data-retry-menu]');
    if (retry) loadMenu();
  });

  refs.featuredRail.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-product]');
    if (button) openItem(button.dataset.openProduct);
  });

  // Carrinho flutuante / botão do topo
  refs.topCartButton.addEventListener('click', openCart);
  refs.cartBar.addEventListener('click', openCart);

  // Fechar diálogos
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) closeDialog(document.getElementById(closer.dataset.closeDialog));
  });

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('close', syncBodyLock);
    dialog.addEventListener('cancel', () => setTimeout(syncBodyLock, 0));
  }

  refs.itemDialog.addEventListener('click', (event) => {
    if (event.target === refs.itemDialog) closeDialog(refs.itemDialog);
  });

  // Modal de item
  refs.itemDialog.addEventListener('click', (event) => {
    const stepButton = event.target.closest('[data-item-step]');
    if (stepButton) {
      const step = Number(stepButton.dataset.itemStep);
      state.dialogQty = Math.min(20, Math.max(1, state.dialogQty + step));
      renderItemDialog();
      return;
    }
    const addButton = event.target.closest('[data-item-add]');
    if (addButton && state.dialogProduct) {
      const notes = $('#item-notes-input')?.value || '';
      addToCart(state.dialogProduct, state.dialogQty, notes);
      closeDialog(refs.itemDialog);
    }
  });

  refs.itemDialog.addEventListener('input', (event) => {
    if (event.target.id === 'item-notes-input') state.dialogNotes = event.target.value;
  });

  // Carrinho / checkout
  refs.cartBody.addEventListener('click', (event) => {
    const inc = event.target.closest('[data-cart-inc]');
    if (inc) return changeQuantity(inc.dataset.cartInc, inc.dataset.notes, 1);
    const dec = event.target.closest('[data-cart-dec]');
    if (dec) return changeQuantity(dec.dataset.cartDec, dec.dataset.notes, -1);
    const remove = event.target.closest('[data-cart-remove]');
    if (remove) return removeCartItem(remove.dataset.cartRemove, remove.dataset.notes);

    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-cart') {
      closeDialog(refs.cartDialog);
      if (state.route.name !== 'menu') location.hash = '#/';
      return;
    }
    if (action === 'go-checkout') {
      state.cartStep = 'checkout';
      renderCartStep();
      refs.cartBody.scrollTop = 0;
    }
  });

  refs.cartFoot.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'back-to-cart') {
      state.cartStep = 'cart';
      renderCartStep();
      return;
    }
    if (action === 'go-checkout') {
      state.cartStep = 'checkout';
      renderCartStep();
    }
  });

  refs.cartDialog.addEventListener('change', (event) => {
    if (event.target.name === 'serviceType') {
      const tableField = $('#table-field');
      if (tableField) tableField.hidden = event.target.value === 'balcao';
    }
  });

  refs.cartDialog.addEventListener('submit', (event) => {
    if (event.target.id !== 'checkout-form') return;
    event.preventDefault();
    submitOrder(event.target);
  });

  // Consulta de pedido
  refs.lookupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = refs.lookupCode.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 3) {
      toast('Digite o código de 4 caracteres do pedido.', { type: 'error' });
      refs.lookupCode.focus();
      return;
    }
    location.hash = `#/pedido/${code}`;
  });

  refs.recentOrders.addEventListener('click', (event) => {
    if (event.target.closest('a')) refs.recentSection.hidden = false;
  });

  // Hero: rolar até o cardápio
  $('#hero-cta')?.addEventListener('click', () => {
    setTimeout(() => {
      $('#menu-sticky')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
  });

  // Rede
  window.addEventListener('online', () => {
    updateOfflineBanner();
    toast('Conexão restabelecida.', { type: 'info', duration: 2200 });
    if (!state.menu) loadMenu();
  });
  window.addEventListener('offline', () => {
    updateOfflineBanner();
    toast('Você está offline. O cardápio salvo continua disponível.', {
      type: 'error',
      duration: 5000,
    });
  });

  window.addEventListener('hashchange', handleRoute);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.track.timer);
    } else if (state.route.name === 'track' && state.track.order) {
      scheduleTrackPoll();
    }
  });
}

/* --------------------------------------------------------------------------
   Inicialização
   -------------------------------------------------------------------------- */

function init() {
  bindEvents();
  setupPwa();
  updateCartUI();
  updateOfflineBanner();
  updateInstallButtons();
  renderRecentOrders();
  if (refs.footerYear) refs.footerYear.textContent = String(new Date().getFullYear());
  handleRoute();
  loadMenu();

  if (location.hash.startsWith('#/pedido/')) {
    refs.lookupCode.value = parseRoute().code || '';
  }
}

init();
