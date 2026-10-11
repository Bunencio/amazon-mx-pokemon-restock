# Fixtures

Páginas reales de amazon.com.mx capturadas con `npm run check -- … --save-fixture <nombre>`,
sanitizadas (`src/amazon/fixtureSanitizer.js` quita session-id, ubid, tokens CSRF, requestId…)
y comprimidas. Cada `.html.gz` tiene un `.meta.json` con la URL, fecha, tamaño y clasificación.

| Fixture | Qué es | Uso en tests |
|---|---|---|
| `dp-amazon-in-stock` | B0GR6N18F6 vendido por **Amazon México** (`merchantID=AVDBXBAVVSXLQ`, "Disponible", $1,099) | parser + clasificador → `amazon_in_stock` |
| `dp-3p-fba-B0H8SV3WJ8` | ETB 30th Celebration vendido por un revendedor FBA ("Colecciona MX", enviado por Amazon) | nunca debe clasificarse como Amazon |
| `dp-no-offers-B0H7818YHY` | Binder Collection: listing sin ninguna oferta comprable (`#unqualifiedBuyBox`, `merchantID=""`, "Ver opciones de compra") | `out_of_stock` con confianza alta |
| `search-filtered` | Búsqueda con `rh=p_6:AVDBXBAVVSXLQ` (solo ofertas de Amazon México) | parser de tarjetas |
| `search-unfiltered` | Misma búsqueda sin filtro (≈29 ASINs de la línea 30th) | parser + filtro de títulos |
| `blocked-captcha-dp` | Robot-check de Amazon (~4 KB) que recibe el `fetch` plano de Node | validador → `captcha` |
| `blocked-soft-search` | Interstitial de Akamai Bot Manager (`bm-verify`, ~2.4 KB) | validador → `challenge` |

Para capturar un fixture nuevo (p. ej. la primera pre-orden de Amazon México):

```
npm run check -- <ASIN> --rendered --save-fixture dp-amazon-preorder
```

`test/mock/` (ignorado por git si lo regeneras) contiene copias renombradas para `MOCK_HTML_DIR`.
