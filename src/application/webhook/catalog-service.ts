import type { MetaOrder } from "../../domain/meta-webhook";

const GRAPH_API_BASE = "https://graph.facebook.com/v22.0";

/// Teto de produtos lidos do catálogo — vão inteiros pro prompt do agente,
/// então um catálogo enorme não pode estourar o contexto.
const MAX_PRODUCTS = 150;
const PAGE_SIZE = 100;
/// O catálogo muda pouco e a leitura é por mensagem — cache em memória por
/// catálogo. Falha fica em cache por menos tempo, pra se recuperar logo.
const CACHE_TTL_MS = 10 * 60 * 1000;
const ERROR_CACHE_TTL_MS = 60 * 1000;

export interface CatalogProduct {
  retailerId: string;
  name: string;
  /// Já formatado pela Meta (ex: "R$ 89,90").
  price: string | null;
  availability: string | null;
}

interface MetaProductsResponse {
  data?: { retailer_id?: string; name?: string; price?: string; availability?: string }[];
  paging?: { next?: string };
  error?: { message?: string };
}

const cache = new Map<string, { products: CatalogProduct[]; expiresAt: number }>();

/// Produtos do catálogo da Meta (até MAX_PRODUCTS). Best-effort: qualquer
/// falha (token sem catalog_management, catálogo apagado...) loga e devolve
/// lista vazia — a conversa segue, só sem produtos.
export async function getCatalogProducts(catalogId: string, accessToken: string | null): Promise<CatalogProduct[]> {
  if (!accessToken) return [];

  const cached = cache.get(catalogId);
  if (cached && cached.expiresAt > Date.now()) return cached.products;

  const products: CatalogProduct[] = [];
  let url: string | undefined =
    `${GRAPH_API_BASE}/${catalogId}/products?fields=retailer_id,name,price,availability&limit=${PAGE_SIZE}`;

  try {
    while (url && products.length < MAX_PRODUCTS) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = (await response.json().catch(() => ({}))) as MetaProductsResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `Meta respondeu ${response.status}`);

      for (const item of body.data ?? []) {
        if (!item.retailer_id) continue;
        products.push({
          retailerId: item.retailer_id,
          name: item.name ?? item.retailer_id,
          price: item.price ?? null,
          availability: item.availability ?? null,
        });
      }
      url = body.paging?.next;
    }
  } catch (error) {
    console.error(`[CATALOG] falha ao ler produtos do catálogo ${catalogId}:`, error);
    cache.set(catalogId, { products: [], expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return [];
  }

  const result = products.slice(0, MAX_PRODUCTS);
  cache.set(catalogId, { products: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

function formatMoney(value: number | string | undefined, currency: string | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL" }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toFixed(2)}`.trim();
  }
}

/// Carrinho enviado pelo contato (webhook type=order) vira texto — é assim
/// que ele segue pro agente (e pro histórico), igual a uma mensagem digitada.
/// A Meta só manda o SKU, o nome vem do catálogo quando dá pra ler.
export async function formatOrderText(order: MetaOrder, accessToken: string | null): Promise<string> {
  const products = order.catalog_id ? await getCatalogProducts(order.catalog_id, accessToken) : [];
  const nameBySku = new Map(products.map((p) => [p.retailerId, p.name]));

  let total = 0;
  let currency: string | undefined;
  const lines = (order.product_items ?? []).map((item) => {
    const quantity = Number(item.quantity) || 1;
    const price = Number(item.item_price);
    if (Number.isFinite(price)) total += price * quantity;
    currency = currency ?? item.currency;
    const name = nameBySku.get(item.product_retailer_id) ?? item.product_retailer_id;
    const unit = formatMoney(item.item_price, item.currency);
    return `- ${quantity}x ${name} (SKU ${item.product_retailer_id})${unit ? `, ${unit} cada` : ""}`;
  });

  const parts = ["🛒 Pedido enviado pelo catálogo:", ...lines];
  if (lines.length > 0 && total > 0) parts.push(`Total: ${formatMoney(total, currency)}`);
  if (order.text?.trim()) parts.push(`Mensagem do cliente: ${order.text.trim()}`);
  return parts.join("\n");
}
