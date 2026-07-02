import type { Product, SaleItem } from "./types";

export const storageKeys = {
  catalog: "marketflow.catalog",
  sale: "marketflow.sale",
  settings: "marketflow.settings",
  favorites: "marketflow.favorites",
};

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson<T>(key: string, payload: T) {
  window.localStorage.setItem(key, JSON.stringify(payload));
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

export function calculateTotals(items: SaleItem[]) {
  return items.reduce(
    (acc, item) => {
      acc.total += item.price * item.quantity;
      acc.units += item.quantity;
      acc.distinct += 1;
      return acc;
    },
    { total: 0, units: 0, distinct: 0 },
  );
}

export function upsertSaleItem(items: SaleItem[], product: Product) {
  const existing = items.find((item) => item.barcode === product.barcode);
  if (existing) {
    return items.map((item) =>
      item.barcode === product.barcode
        ? { ...item, quantity: item.quantity + 1 }
        : item,
    );
  }

  return [...items, { ...product, quantity: 1 }];
}

export function removeSaleItem(items: SaleItem[], barcode: string) {
  return items
    .map((item) =>
      item.barcode === barcode ? { ...item, quantity: item.quantity - 1 } : item,
    )
    .filter((item) => item.quantity > 0);
}
