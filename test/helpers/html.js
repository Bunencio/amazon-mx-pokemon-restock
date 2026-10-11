/**
 * Synthetic Amazon-like HTML for unit tests. Mirrors the real markup observed on
 * amazon.com.mx (2026-10-10) closely enough to exercise the selectors.
 */
export function buildDpHtml(opts = {}) {
  const {
    asin = 'B0TEST0001',
    title = 'Pokémon TCG: 30th Celebration Elite Trainer Box',
    merchantId = 'AVDBXBAVVSXLQ',
    merchantName = 'Amazon México',
    sellerLink = false,
    fulfiller = 'Amazon',
    availability = 'Disponible',
    addToCart = true,
    addToCartLabel = 'Agregar al carrito',
    addToCartDisabled = false,
    buyNow = true,
    buyNowLabel = 'Comprar ahora',
    price = '$1,099.00',
    olp = null,
    seeAll = false,
    twister = null,
    releaseBullet = null,
    padTo = 0,
    fdp = false,
  } = opts;

  const merchantBlock = merchantId
    ? `<input type="hidden" id="merchantID" name="merchantID" value="${merchantId}">`
    : '';
  const sellerBlock = sellerLink
    ? `<a href='/gp/help/seller/at-a-glance.html/ref=dp_merchant_link?ie=UTF8&amp;seller=${merchantId}&amp;asin=${asin}' id='sellerProfileTriggerId' class='a-size-small a-link-normal'>${merchantName}</a>`
    : `<span class="a-size-small offer-display-feature-text-message">${merchantName || ''}</span>`;

  const parts = [];
  parts.push('<!doctype html><html lang="es-mx"><head><meta charset="utf-8">');
  parts.push(`<title>${title} : Amazon.com.mx: Juguetes y Juegos</title>`);
  parts.push(`<link rel="canonical" href="https://www.amazon.com.mx/dp/${asin}">`);
  parts.push('</head><body>');
  if (fdp) parts.push('<!-- Fallback Detail Page --><script>window.isFDPRequest = true;</script>');
  parts.push('<div id="dp" class="toys-and-games"><div id="dp-container"><div id="ppd"><div id="centerCol">');
  parts.push(`<span id="productTitle" class="a-size-large product-title-word-break"> ${title} </span>`);
  if (price) {
    parts.push(
      `<div id="corePrice_feature_div"><span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay"><span class="a-offscreen">${price}</span><span aria-hidden="true">${price}</span></span></div>`,
    );
  }
  parts.push('</div><div id="rightCol"><div id="desktop_buybox"><div id="buybox">');
  parts.push(`<form><input type="hidden" id="ASIN" name="ASIN" value="${asin}">${merchantBlock}`);
  if (availability != null) {
    parts.push(
      `<div id="availability" class="a-section"><span class="a-size-medium a-color-success primary-availability-message">${availability}</span></div>`,
    );
  }
  if (addToCart) {
    const disabledAttr = addToCartDisabled ? ' disabled' : '';
    parts.push(
      `<span id="submit.add-to-cart" class="a-button a-button-primary${addToCartDisabled ? ' a-button-disabled' : ''}"><span class="a-button-inner"><input id="add-to-cart-button" name="submit.add-to-cart" title="${addToCartLabel}" class="a-button-input" type="submit" value="${addToCartLabel}"${disabledAttr}/></span></span>`,
    );
  }
  if (buyNow) {
    parts.push(
      `<span id="submit.buy-now" class="a-button a-button-primary"><span class="a-button-inner"><input id="buy-now-button" name="submit.buy-now" class="a-button-input" type="submit" aria-labelledby="submit.buy-now-announce"/><span id="submit.buy-now-announce" class="a-button-text">${buyNowLabel}</span></span></span>`,
    );
  }
  if (seeAll) parts.push('<div id="buybox-see-all-buying-choices"><a>Ver todas las opciones de compra</a></div>');
  parts.push('<div class="offer-display-feature" role="heading"><span class="a-size-small a-color-tertiary">Vendido por</span></div>');
  parts.push(
    `<div class="offer-display-feature-text a-size-small" data-csa-c-type="widget" data-csa-c-slot-id="odf-feature-text-desktop-merchant-info" data-csa-c-content-id="desktop-merchant-info"><div class="offer-display-feature-text a-spacing-none odf-truncation-popover">${sellerBlock}</div></div>`,
  );
  if (fulfiller) {
    parts.push(
      `<div class="offer-display-feature-text a-size-small" data-csa-c-type="widget" data-csa-c-slot-id="odf-feature-text-desktop-fulfiller-info" data-csa-c-content-id="desktop-fulfiller-info"><div class="offer-display-feature-text a-spacing-none"><span class="a-size-small offer-display-feature-text-message">${fulfiller}</span></div></div>`,
    );
  }
  parts.push('</form></div></div>');
  if (olp) parts.push(`<div id="olpLinkWidget_feature_div" class="celwidget"><a href="/gp/offer-listing/${asin}">${olp}</a></div>`);
  parts.push('</div></div>');
  parts.push(`<div id="imgTagWrapperId"><img id="landingImage" src="https://m.media-amazon.com/images/I/test.jpg" data-old-hires="https://m.media-amazon.com/images/I/test-hires.jpg"></div>`);
  if (releaseBullet) {
    parts.push(`<div id="detailBullets_feature_div"><ul><li><span><span class="a-text-bold">Fecha de lanzamiento :</span> <span>${releaseBullet}</span></span></li></ul></div>`);
  }
  if (twister) {
    parts.push(`<script>var dataToReturn = { "dimensionValuesDisplayData" : ${JSON.stringify(twister)}, "parentAsin" : "B0PARENT01" };</script>`);
  }
  parts.push('</div></div></body></html>');

  let html = parts.join('\n');
  if (padTo && html.length < padTo) {
    html = html.replace('</body>', `<!-- ${' '.repeat(padTo - html.length)} --></body>`);
  }
  return html;
}

export function buildSearchHtml(cards = [], { noResults = false } = {}) {
  const items = cards
    .map((c) => {
      const href = c.sponsored ? `/sspa/click?ie=UTF8&url=%2Fdp%2F${c.asin}` : `/Some-Product/dp/${c.asin}/ref=sr_1_1`;
      const sponsored = c.sponsored ? '<span class="puis-sponsored-label-text">Patrocinado</span>' : '';
      const price = c.price ? `<span class="a-price"><span class="a-offscreen">${c.price}</span></span>` : '';
      const unavailable = c.unavailable ? '<div class="a-row"><span class="a-size-small">No disponible por el momento.</span></div>' : '';
      return `<div data-asin="${c.asin}" data-component-type="s-search-result" class="s-result-item">${sponsored}<h2 class="a-size-base-plus"><a class="a-link-normal s-no-outline" href="${href}"><span>${c.title}</span></a></h2>${price}${unavailable}<img class="s-image" src="https://m.media-amazon.com/images/I/${c.asin}.jpg"></div>`;
    })
    .join('\n');
  const body = noResults
    ? '<div class="s-main-slot"><span>No se encontraron resultados para la búsqueda.</span></div>'
    : `<div class="s-main-slot s-result-list">${items}</div>`;
  return `<!doctype html><html lang="es-mx"><head><title>Amazon.com.mx : test</title></head><body><div id="search">${body}</div></body></html>`;
}
