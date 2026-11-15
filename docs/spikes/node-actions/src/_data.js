// Deterministic rows for the spreadsheet/CSV workloads: 20 columns (10 text, 1 date, 9 numbers), like a typical
// "import customers/orders" sheet. Same generator in Node (fixtures, reference) and in workerd (write workloads).
export const HEADERS = [
  "id", "code", "name", "email", "city", "category", "status", "sku", "description", "created",
  "qty", "price", "discount", "tax", "total", "weight", "score", "lat", "lng", "notes",
];
const CITIES = ["São Paulo", "Lisboa", "Porto", "Recife", "Curitiba", "Madrid", "Austin", "Berlin", "Osaka", "Lima"];
const CATS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const STATUS = ["open", "paid", "void", "late"];

function rnd(i, k) {
  let x = (i * 2654435761 + k * 40503) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995) >>> 0; x ^= x >>> 15;
  return x / 4294967296;
}

export function row(i) {
  const r = (k) => rnd(i, k);
  const qty = 1 + Math.floor(r(1) * 50);
  const price = Math.round(r(2) * 100000) / 100;
  return [
    i,
    `C-${(i * 7919).toString(36).toUpperCase()}`,
    `Customer ${i} ${CITIES[i % 10]}`,
    `user${i}@example.test`,
    CITIES[Math.floor(r(3) * 10)],
    CATS[Math.floor(r(4) * 6)],
    STATUS[Math.floor(r(5) * 4)],
    `SKU-${Math.floor(r(6) * 1e6)}`,
    `Item ${i}: ${CATS[i % 6]} order, batch ${Math.floor(r(7) * 1000)}`,
    new Date(Date.UTC(2024, 0, 1) + Math.floor(r(8) * 3e10)).toISOString().slice(0, 10),
    qty,
    price,
    Math.round(r(9) * 30) / 100,
    Math.round(r(10) * 20) / 100,
    Math.round(qty * price * 100) / 100,
    Math.round(r(11) * 5000) / 100,
    Math.floor(r(12) * 1000),
    Math.round((r(13) * 180 - 90) * 1e5) / 1e5,
    Math.round((r(14) * 360 - 180) * 1e5) / 1e5,
    r(15) < 0.5 ? "" : `note ${i}`,
  ];
}

export function csvLine(values) {
  return values.map((v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))).join(",");
}
