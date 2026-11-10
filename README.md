# TrekMap Web (iPhone)

Web app installabile (PWA) per il trekking: mappe offline `.mbtiles` caricate a mano + GPS + tracce GPX.
Nessun Mac e nessun account Apple Developer necessari.

## Pubblicare (una volta sola, gratis)
1. Crea un repository su GitHub e carica **il contenuto di questa cartella** (i file `index.html`, `app.js`, ... devono stare nella radice).
2. Repository → **Settings → Pages** → Source: *Deploy from a branch* → branch `main`, cartella `/ (root)` → Save.
3. Dopo ~1 minuto trovi l'indirizzo `https://TUONOME.github.io/NOMEREPO/`.

## Installare su iPhone
1. Apri l'indirizzo in **Safari** (con la rete).
2. Condividi → **Aggiungi alla schermata Home**.
3. Apri TrekMap dall'icona sulla Home: da ora si avvia anche senza rete.
4. **Mappe → Aggiungi mappa** e scegli un `.mbtiles` dai File (iCloud Drive, Download, AirDrop...).

## Limiti da conoscere
- Mappe **raster** (png/jpg/webp). Le vettoriali (pbf) non sono ancora supportate.
- Il GPS di Safari funziona **solo con l'app aperta e lo schermo acceso** (l'app lo tiene acceso da sola). Se blocchi il telefono la registrazione si ferma.
- Se non apri l'app per molto tempo iOS può cancellare i dati dei siti: tieni sempre una copia dei `.mbtiles` e dei GPX esportati.

## Test
`tools/make_test_mbtiles.py out.mbtiles [indexed|noindex|norowid] [maxzoom]` crea una mappa di prova.
