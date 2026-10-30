import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { databaseKind } from './db.js';
import {
  createOrder,
  getMenu,
  getOrderByCode,
  getStats,
  listAdminProducts,
  listOrders,
  setProductAvailability,
  updateOrderStatus,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ADMIN_PIN = process.env.ADMIN_PIN || '2468';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const SERVICE_TYPES = new Set(['mesa', 'balcao']);
const PAYMENT_METHODS = new Set(['pix', 'cartao', 'dinheiro']);

function httpError(status, message, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r/g, '').trim().slice(0, maxLength);
}

function validateOrderPayload(body) {
  const customerName = cleanText(body?.customerName, 60);
  if (customerName.length < 2) {
    throw httpError(400, 'Informe seu nome (pelo menos 2 letras).', 'INVALID_NAME');
  }

  const serviceType = cleanText(body?.serviceType, 20) || 'mesa';
  if (!SERVICE_TYPES.has(serviceType)) {
    throw httpError(400, 'Escolha entre comer na mesa ou retirar no balcão.', 'INVALID_SERVICE');
  }

  let tableNumber = cleanText(body?.tableNumber, 4);
  if (serviceType === 'mesa') {
    if (!/^\d{1,3}$/.test(tableNumber) || Number(tableNumber) < 1) {
      throw httpError(400, 'Informe o número da mesa (1 a 999).', 'INVALID_TABLE');
    }
    tableNumber = String(Number(tableNumber)).padStart(2, '0');
  } else {
    tableNumber = '';
  }

  const paymentMethod = cleanText(body?.paymentMethod, 20);
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    throw httpError(400, 'Escolha uma forma de pagamento.', 'INVALID_PAYMENT');
  }

  const notes = cleanMultiline(body?.notes, 180);

  if (!Array.isArray(body?.items) || body.items.length === 0) {
    throw httpError(400, 'Seu pedido está vazio.', 'EMPTY_ORDER');
  }
  if (body.items.length > 30) {
    throw httpError(400, 'Muitos itens em um único pedido.', 'TOO_MANY_ITEMS');
  }

  const merged = new Map();
  for (const rawItem of body.items) {
    const productId = cleanText(rawItem?.productId, 64);
    const quantity = Number(rawItem?.quantity);
    const itemNotes = cleanMultiline(rawItem?.notes, 120);
    if (!productId) {
      throw httpError(400, 'Item do pedido inválido.', 'INVALID_ITEM');
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw httpError(400, 'Quantidade inválida (use de 1 a 20).', 'INVALID_QUANTITY');
    }
    const key = `${productId}::${itemNotes}`;
    const current = merged.get(key);
    if (current) {
      current.quantity = Math.min(20, current.quantity + quantity);
    } else {
      merged.set(key, { productId, quantity, notes: itemNotes || null });
    }
  }

  return {
    customerName,
    serviceType,
    tableNumber,
    paymentMethod,
    notes: notes || null,
    items: [...merged.values()],
  };
}

function timingSafeEqualStrings(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function requireAdmin(req, res, next) {
  const pin = req.get('x-admin-pin') || req.body?.pin || '';
  if (!timingSafeEqualStrings(pin, ADMIN_PIN)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'PIN incorreto. Tente novamente.' },
    });
  }
  return next();
}

/** Rate limit simples em memória (suficiente para um totem). */
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  timer.unref?.();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: message || 'Muitas tentativas. Aguarde um instante.' },
      });
    }
    return next();
  };
}

function startOfToday() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return start.toISOString();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; '),
    });
    next();
  });

  app.use(express.json({ limit: '48kb' }));

  const orderLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 40,
    message: 'Muitos pedidos em sequência. Aguarde um minutinho.',
  });
  const loginLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: 12,
    message: 'Muitas tentativas de PIN. Aguarde alguns minutos.',
  });

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      database: databaseKind(),
      time: new Date().toISOString(),
    });
  });

  app.get('/api/menu', async (req, res, next) => {
    try {
      const menu = await getMenu();
      res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=60');
      res.json(menu);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/orders', orderLimiter, async (req, res, next) => {
    try {
      const payload = validateOrderPayload(req.body);
      const order = await createOrder(payload);
      res.status(201).json({ order });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/orders/:code', async (req, res, next) => {
    try {
      const code = cleanText(req.params.code, 8).toUpperCase();
      if (!/^[A-Z0-9]{3,8}$/.test(code)) {
        throw httpError(400, 'Código de pedido inválido.', 'INVALID_CODE');
      }
      const order = await getOrderByCode(code);
      if (!order) throw httpError(404, 'Pedido não encontrado.', 'ORDER_NOT_FOUND');
      res.set('Cache-Control', 'no-store');
      res.json({ order });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const pin = String(req.body?.pin || '');
    if (!timingSafeEqualStrings(pin, ADMIN_PIN)) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'PIN incorreto. Tente novamente.' },
      });
    }
    return res.json({ ok: true });
  });

  app.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
    try {
      const view = ['active', 'history', 'all'].includes(req.query.view)
        ? req.query.view
        : 'active';
      const orders = await listOrders({ view, limit: req.query.limit });
      res.set('Cache-Control', 'no-store');
      res.json({ orders, view });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res, next) => {
    try {
      const status = cleanText(req.body?.status, 20);
      const order = await updateOrderStatus(req.params.id, status);
      res.json({ order });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/products', requireAdmin, async (req, res, next) => {
    try {
      const products = await listAdminProducts();
      res.set('Cache-Control', 'no-store');
      res.json({ products });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
    try {
      if (typeof req.body?.available !== 'boolean') {
        throw httpError(400, 'Envie "available" como booleano.', 'INVALID_AVAILABILITY');
      }
      const product = await setProductAvailability(req.params.id, req.body.available);
      res.json({ product });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
    try {
      const stats = await getStats(startOfToday());
      res.set('Cache-Control', 'no-store');
      res.json({ stats, timezone: process.env.TZ });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Rota de API não encontrada.' },
    });
  });

  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (name === 'index.html' || name === 'sw.js' || name === 'manifest.webmanifest') {
          res.set('Cache-Control', 'no-cache');
        } else if (/\.(woff2|png|svg|ico)$/.test(name)) {
          res.set('Cache-Control', 'public, max-age=604800');
        } else {
          res.set('Cache-Control', 'public, max-age=300');
        }
      },
    }),
  );

  // SPA fallback: qualquer rota desconhecida devolve o app.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status) || 500;
    if (status >= 500) {
      console.error('[api] erro:', error);
    }
    return res.status(status).json({
      error: {
        code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message:
          status >= 500
            ? 'Algo deu errado por aqui. Tente novamente em instantes.'
            : error.message,
      },
    });
  });

  return app;
}
