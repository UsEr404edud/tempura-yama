/** Utilitários compartilhados pelo front-end. */

const priceFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function formatPrice(cents) {
  return priceFormatter.format((Number(cents) || 0) / 100);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export class ApiError extends Error {
  constructor(message, status = 0, code = 'UNKNOWN') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, pin, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (pin) headers['x-admin-pin'] = pin;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Sem conexão com o totem. Verifique sua internet.', 0, 'NETWORK');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error?.message || 'Não foi possível concluir a operação.',
      response.status,
      data?.error?.code || 'HTTP_ERROR',
    );
  }

  return data;
}

export function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* modo privado / quota cheia: seguimos sem persistir */
  }
}

export function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignora */
  }
}

export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return 'agora';
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export const ORDER_STATUS_META = {
  recebido: {
    label: 'Recebido',
    title: 'Pedido recebido',
    description: 'Recebemos seu pedido e já mandamos para a cozinha.',
    badge: 'Recebido',
  },
  preparando: {
    label: 'Em preparo',
    title: 'Na cozinha',
    description: 'Nossos cozinheiros estão fritando tudo na hora.',
    badge: 'Em preparo',
  },
  pronto: {
    label: 'Pronto',
    title: 'Pronto para servir',
    description: 'Sua bandeja está saindo da cozinha.',
    badge: 'Pronto',
  },
  entregue: {
    label: 'Entregue',
    title: 'Pedido entregue',
    description: 'Bom apetite! Obrigado pela visita.',
    badge: 'Entregue',
  },
  cancelado: {
    label: 'Cancelado',
    title: 'Pedido cancelado',
    description: 'Fale com a equipe do balcão se precisar de ajuda.',
    badge: 'Cancelado',
  },
};
