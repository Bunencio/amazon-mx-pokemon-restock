# Pokémon Restock Monitor — Amazon México

Monitor gratuito que vigila amazon.com.mx y avisa por Discord cuando **Amazon México
(el vendedor oficial, no revendedores)** vuelve a tener en stock —o abre pre-orden de—
cualquier producto de la línea **Pokémon TCG: 30th Celebration** (ETB, Booster Bundle,
Mini Tins, ex Boxes, Ultra-Premium Collections, sobres…).

- Corre en tu **PC** cada 10 min (Task Scheduler) y, como **respaldo**, en GitHub Actions
  cada 15 min (repo público = minutos ilimitados). Ambos comparten estado en un Gist.
- Usa un Chromium real (Playwright) con sesión persistida. Sin evasión: si Amazon
  bloquea, el monitor avisa una vez al día, hace *backoff* y reintenta.
- Alerta solo en transiciones reales (agotado → disponible por Amazon México), con
  anti-flapping y sin duplicados entre runners.

## Cómo decide "vendido por Amazon México"

Verificado en páginas reales (2026-10-10):

| Señal | Dónde | Valor para Amazon México |
|---|---|---|
| Vendedor del buybox | `input#merchantID` | `AVDBXBAVVSXLQ` |
| Nombre del vendedor | `…odf-feature-text-desktop-merchant-info … .offer-display-feature-text-message` | "Amazon México" **sin** link de vendedor |
| Revendedor | `a#sellerProfileTriggerId[href*="seller="]` | presente → NO es Amazon (aunque "Enviado por Amazon") |
| Disponibilidad | `#availability .primary-availability-message` | "Disponible", "Sólo queda(n) N en stock." vs "No disponible por el momento." |
| Botones | `#add-to-cart-button`, `#buy-now-button` | presentes y habilitados |

La URL que se consulta fija el vendedor: `https://www.amazon.com.mx/dp/<ASIN>?smid=AVDBXBAVVSXLQ&th=1&psc=1`.
Además, la búsqueda `s?k=…&rh=p_6%3AAVDBXBAVVSXLQ` lista únicamente lo que Amazon México
ofrece (una sola petición) y sirve como señal rápida + descubrimiento de ASINs nuevos.

### Estados y eventos

```
unknown → amazon_in_stock      evento IN_STOCK   (episodio +1) → alerta con @rol
       → amazon_preorder      evento PREORDER   (episodio +1) → alerta con @rol
       → out_of_stock         Amazon México lo lista pero sin oferta comprable (estado "pre-restock")
       → third_party_only     el buybox es de un revendedor (FBA incluido)
       → delisted             3 × 404 seguidos
```

- Solo una página **válida** cambia el estado. Páginas degradadas (captcha, interstitial
  de Akamai, "Fallback Detail Page", truncadas, 503) nunca se interpretan como "agotado".
- Clave de deduplicación `ASIN:EVENTO:episodio`: un mismo episodio no repite; un restock
  posterior (tras agotarse) sí vuelve a alertar.
- `ALERT_COOLDOWN_MIN` (30) evita spam si el stock parpadea.
- Una transición positiva con confianza media/baja se **confirma** con una segunda lectura
  antes de alertar.
- `ALERT_ON_FIRST_OBSERVATION=true`: si al arrancar algo ya está disponible por Amazon, avisa.

## Arquitectura

```
src/jobs/runRestockMonitor.js   una pasada: gates → plan → fetch/clasificar → confirmaciones → alertas → persistir
src/core/planner.js             presupuesto de peticiones, prioridades, round-robin, tareas periódicas
src/core/statusMachine.js       observación → estado, episodios, decisión de alerta
src/core/titleFilter.js         ¿el título pertenece a la línea 30th Celebration?
src/amazon/*                    fetcher (Playwright/estático/mock), validador, parsers, clasificador
src/services/*                  config, logger, Discord REST, stores (archivo / gist / artifact)
watchlist.json                  ASINs semilla, consultas, regex de títulos, páginas de la tienda
```

**Presupuesto por corrida** (`MAX_REQUESTS_PER_RUN`, PC 10 / Actions 5): 1 búsqueda filtrada
+ todos los ASIN de prioridad 1 + round-robin de prioridad 2–3 + 1 petición de reserva
(confirmaciones / "ASIN caliente" que la búsqueda muestra disponible). Cada hora, 2 búsquedas
de descubrimiento; una vez al día (solo PC), barrido de la tienda de marca con Playwright.
Entre peticiones hay una pausa aleatoria de 2–5 s.

**Bloqueos**: un captcha/503 (bloqueo duro) o 2 páginas degradadas en una corrida → se aborta,
aviso en Discord (1/día/runner), backoff 10 → 20 → 40 → 80 → 160 min, presupuesto a la mitad
(se recupera +1 por día limpio). Un bloqueo duro además renueva la sesión del navegador; una
sesión nueva siempre abre primero la portada de amazon.com.mx (como una persona) antes de
visitar productos. Es normal ver algún captcha el primer día tras muchas pruebas manuales desde
la misma IP; la reputación se recupera sola con el ritmo normal del monitor.

## Instalación en el PC

Requisitos: Node ≥ 22 (hay v22.17), el bot de Discord del proyecto Alert, cuenta de GitHub.

1. **Canal de Discord**: crea `#pokemon-restock` en el mismo servidor del bot; dale al bot
   *Ver canal*, *Enviar mensajes*, *Insertar enlaces*. Copia el ID del canal (y del rol a
   mencionar, opcional).
2. **Gist compartido** (recomendado; permite el failover PC ↔ Actions sin duplicados):
   crea un PAT **clásico** con único scope `gist` en <https://github.com/settings/tokens/new?scopes=gist>.
3. Configura:
   ```
   cd PokemonRestock
   npm install
   copy .env.example .env      # rellena DISCORD_BOT_TOKEN (del Alert), DISCORD_CHANNEL_ID, DISCORD_MENTION_ROLE_ID, GIST_TOKEN
   npm run gist:init           # crea el gist e imprime GIST_ID → pégalo en .env
   npm run doctor              # TLS, Discord, gist, Playwright y una lectura real de Amazon
   npm run test:alert          # publica una alerta de PRUEBA en el canal
   ```
4. Prueba una pasada manual (sin publicar): `npm run monitor` (localmente `SEND_DISCORD=false`
   por defecto; revisa `state/shared.json`). Para publicar de verdad: `set SEND_DISCORD=true && npm run monitor`.
   > Un dry-run **sí** guarda estado (la primera observación se consume sin publicar). Antes de
   > activar las alertas reales borra `state\shared.json` (o apunta las pruebas a otro archivo con
   > `STATE_FILE=state/dryrun.json`) para que la primera corrida real avise de lo que ya esté disponible.
5. **Tarea programada** (cada 10 min, ventana oculta, se reanuda tras suspender el equipo):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
   ```
   Logs en `logs\monitor-YYYY-MM-DD.log` (14 días). Quitar: `scripts\uninstall-task.ps1`.

`run-monitor.cmd` exporta `NODE_OPTIONS=--use-system-ca` para que Node confíe en el
proxy TLS local (Avast) usando el almacén de certificados de Windows.

## Respaldo en GitHub Actions

1. Crea el repo **público** (p. ej. `Bunencio/amazon-mx-pokemon-restock`) y sube el proyecto.
2. Secrets del repo: `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_MENTION_ROLE_ID`,
   `GIST_ID`, `GIST_TOKEN`.
3. `.github/workflows/pokemon-restock.yml` corre a :07/:22/:37/:52 UTC. Antes de hacer nada
   lee el gist: si el PC reportó en los últimos `PC_FRESH_MINUTES` (25) se retira; si lleva
   > `WATCHDOG_STALE_MINUTES` (45) callado, publica un aviso "PC sin latido" y toma el relevo.
4. `keepalive.yml` hace un commit vacío mensual (GitHub apaga los crons tras 60 días sin actividad).

Honestidad sobre Actions: las IPs de datacenter reciben 503 / páginas recortadas / robot-check
con más frecuencia. Su valor garantizado es el **watchdog**; el scraping es *best-effort* y
queda registrado por runner en `history` del estado para que veas su tasa real de éxito.

Sin gist (`STATE_BACKEND=local`): cada runner guarda su propio estado, Actions corre siempre y
un restock puede alertarse dos veces (~15 min de diferencia).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run monitor` | Una pasada del monitor |
| `npm run check -- <ASIN> [--no-smid] [--smid ID] [--aod] [--rendered] [--save-fixture n]` | Inspecciona una página con el mismo pipeline; guarda fixture sanitizado |
| `npm run check -- --search "consulta" [--filtered] [--rendered]` | Lista tarjetas de búsqueda y qué títulos pasan el filtro 30th |
| `npm run check -- --store <pageId>` | Renderiza una página de la tienda de marca |
| `npm run doctor [-- --quick]` | Diagnóstico del entorno |
| `npm run test:alert [-- --preorder] [--no-mention] [--live ASIN] [--dry]` | Publica una alerta de prueba |
| `npm run gist:init` | Crea el gist del estado compartido |
| `npm run mock:init` | Regenera `test/mock/` para simular corridas sin tocar Amazon |
| `npm test` | Tests unitarios (`node --test`) con fixtures reales |

Simulación offline completa (no consume Amazon ni publica):

```
npm run mock:init
set MOCK_HTML_DIR=test/mock
set STATE_FILE=state/mock-shared.json
set RUNNER_STATE_FILE=state/mock-runner.json
set ONLY_ASIN=B0GR6N18F6
npm run monitor                                   # 1ª observación → amazon_in_stock → alerta (dry-run)
npm run monitor                                   # sin cambios → sin alerta
set SIMULATE=B0GR6N18F6=out_of_stock && npm run monitor   # agotado → disponible: episodio 2 → alerta
```

Variables útiles para depurar: `ONLY_ASIN=B0H8SV3WJ8`, `FORCE_RUN=true`,
`SIMULATE=B0H8SV3WJ8=out_of_stock` (fuerza un estado previo para provocar la transición),
`MOCK_HTML_DIR=test/mock` (sirve fixtures en vez de Amazon), `SAVE_DEBUG_HTML=true`,
`FETCH_MODE=static` (hoy recibe captcha desde Node; solo para experimentos).

## Watchlist

`watchlist.json` trae ~29 ASINs de la línea (ETB ×2, Booster Bundle, UPC Day, Binder, Booster
Pack en prioridad 1; Mini Tins, ex Boxes, Poster/Tech Sticker/Knock Out Collections en
prioridad 2). El monitor **descubre** solos los que falten (búsquedas, variaciones "twister",
tienda de marca) y los agrega al estado con prioridad 2 (`NOTIFY_ON_DISCOVERY=true` para
avisarlo). `ignoreAsins` saca un ASIN para siempre.

## Riesgos conocidos

- Amazon cambia su HTML con frecuencia: los selectores tienen alternativas y una página
  "ambigua" nunca alerta; se guarda en `debug/` para ajustar (sube `parserVersion` en
  `src/amazon/constants.js` al cambiar reglas).
- El markup de **pre-orden** aún no se ha observado en Amazon México; la regla exige vendedor
  Amazon + señal fuerte ("se lanzará el…", botón "Pre-ordenar"). Captura el fixture cuando
  aparezca la primera (UPC Day & Night, 6-nov-2026).
- El comportamiento del parámetro `smid` cuando Amazon tiene oferta pero no gana el buybox
  no está verificado; la búsqueda filtrada cubre ese caso como señal independiente.
- 10 min de intervalo pueden perder restocks que se agotan en menos; con
  `scripts\install-task.ps1 -IntervalMinutes 5` y `MAX_REQUESTS_PER_RUN=5` se mantiene el
  mismo volumen por hora con más frecuencia.

## Cumplimiento

Sin resolución de CAPTCHA, sin stealth, sin login, sin proxies: un navegador normal cargando
páginas públicas a ritmo humano (≤ 10 páginas cada 10 min). Si Amazon pide verificación, el
monitor se detiene, avisa y espera.
