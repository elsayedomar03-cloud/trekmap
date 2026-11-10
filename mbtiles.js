// Lettore SQLite minimale (sola lettura) pensato per i file MBTiles.
// Legge il file a pezzi (Blob.slice), quindi non carica mai tutto in memoria:
// funziona anche con mappe da centinaia di MB su iPhone.

const td = new TextDecoder();

function varint(b, o) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const c = b[o + i];
    v = v * 128 + (c & 0x7f);
    if (!(c & 0x80)) { varint.len = i + 1; return v; }
  }
  v = v * 256 + b[o + 8];
  varint.len = 9;
  return v;
}
varint.len = 0;

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function parseRecord(p) {
  const hs = varint(p, 0);
  let pos = varint.len;
  const types = [];
  while (pos < hs) { types.push(varint(p, pos)); pos += varint.len; }
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const out = [];
  let o = hs;
  for (const t of types) {
    if (t === 0) out.push(null);
    else if (t === 8) out.push(0);
    else if (t === 9) out.push(1);
    else if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      let v = 0;
      if (n === 8) v = Number(dv.getBigInt64(o));
      else {
        for (let i = 0; i < n; i++) v = v * 256 + p[o + i];
        if (p[o] & 0x80) v -= 2 ** (8 * n); // complemento a due
      }
      out.push(v); o += n;
    } else if (t === 7) { out.push(dv.getFloat64(o)); o += 8; }
    else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; out.push(p.subarray(o, o + n)); o += n; }
    else if (t >= 13) { const n = (t - 13) / 2; out.push(td.decode(p.subarray(o, o + n))); o += n; }
    else throw new Error('Tipo SQLite non valido');
  }
  return out;
}

class Pager {
  constructor(blob) { this.blob = blob; this.cache = new Map(); }
  async init() {
    const h = new Uint8Array(await this.blob.slice(0, 100).arrayBuffer());
    if (td.decode(h.subarray(0, 15)) !== 'SQLite format 3') {
      throw new Error('Il file non è un MBTiles valido (non è un database SQLite).');
    }
    let ps = u16(h, 16);
    if (ps === 1) ps = 65536;
    this.pageSize = ps;
    this.usable = ps - h[20];
    this.maxCached = Math.max(64, Math.floor(16e6 / ps));
  }
  async page(n, nocache) {
    let p = this.cache.get(n);
    if (p) { this.cache.delete(n); this.cache.set(n, p); return p; }
    const buf = await this.blob.slice((n - 1) * this.pageSize, n * this.pageSize).arrayBuffer();
    p = new Uint8Array(buf);
    if (!nocache) {
      this.cache.set(n, p);
      if (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value);
    }
    return p;
  }
  // Legge il payload di una cella, seguendo le pagine di overflow.
  async payload(page, off, total, maxLocal) {
    if (total <= maxLocal) return page.subarray(off, off + total);
    const U = this.usable;
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    let local = M + ((total - M) % (U - 4));
    if (local > maxLocal) local = M;
    const out = new Uint8Array(total);
    out.set(page.subarray(off, off + local));
    let pos = local;
    let next = u32(page, off + local);
    while (next && pos < total) {
      const op = await this.page(next, true);
      const take = Math.min(U - 4, total - pos);
      out.set(op.subarray(4, 4 + take), pos);
      pos += take;
      next = u32(op, 0);
    }
    return out;
  }
}

class Db {
  constructor(pager) { this.pg = pager; }
  get tableMax() { return this.pg.usable - 35; }
  get indexMax() { return Math.floor(((this.pg.usable - 12) * 64) / 255) - 23; }

  hdr(n, p) {
    const h = n === 1 ? 100 : 0;
    const t = p[h];
    const interior = t === 0x05 || t === 0x02;
    return { h, t, nc: u16(p, h + 3), base: h + (interior ? 12 : 8), right: interior ? u32(p, h + 8) : 0 };
  }

  async walkTable(root, cb) {
    const p = await this.pg.page(root);
    const { t, nc, base, right } = this.hdr(root, p);
    if (t === 0x0d) {
      for (let i = 0; i < nc; i++) {
        let o = u16(p, base + 2 * i);
        const plen = varint(p, o); o += varint.len;
        const rowid = varint(p, o); o += varint.len;
        cb(rowid, parseRecord(await this.pg.payload(p, o, plen, this.tableMax)));
      }
    } else if (t === 0x05) {
      for (let i = 0; i < nc; i++) await this.walkTable(u32(p, u16(p, base + 2 * i)), cb);
      await this.walkTable(right, cb);
    } else throw new Error('Struttura del database non supportata');
  }

  async getRow(root, rowid) {
    let n = root;
    for (;;) {
      const p = await this.pg.page(n);
      const { t, nc, base, right } = this.hdr(n, p);
      if (t === 0x05) {
        let lo = 0, hi = nc;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const o = u16(p, base + 2 * mid);
          if (varint(p, o + 4) < rowid) lo = mid + 1; else hi = mid;
        }
        n = lo < nc ? u32(p, u16(p, base + 2 * lo)) : right;
      } else if (t === 0x0d) {
        let lo = 0, hi = nc - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          let o = u16(p, base + 2 * mid);
          const plen = varint(p, o); o += varint.len;
          const id = varint(p, o); o += varint.len;
          if (id === rowid) return parseRecord(await this.pg.payload(p, o, plen, this.tableMax));
          if (id < rowid) lo = mid + 1; else hi = mid - 1;
        }
        return null;
      } else throw new Error('Struttura del database non supportata');
    }
  }

  // Cerca nell'indice (z, col, riga). Restituisce il record dell'indice o null.
  async indexFind(root, key) {
    const cmp = (r) => (r[0] - key[0]) || (r[1] - key[1]) || (r[2] - key[2]);
    let n = root;
    for (;;) {
      const p = await this.pg.page(n);
      const { t, nc, base, right } = this.hdr(n, p);
      const interior = t === 0x02;
      if (!interior && t !== 0x0a) throw new Error('Struttura dell\'indice non supportata');
      const rec = async (i) => {
        let o = u16(p, base + 2 * i);
        if (interior) o += 4;
        const plen = varint(p, o); o += varint.len;
        return parseRecord(await this.pg.payload(p, o, plen, this.indexMax));
      };
      let lo = 0, hi = nc;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmp(await rec(mid)) < 0) lo = mid + 1; else hi = mid;
      }
      if (lo < nc) {
        const r = await rec(lo);
        if (cmp(r) === 0) return r;
      }
      if (!interior) return null;
      n = lo < nc ? u32(p, u16(p, base + 2 * lo)) : right;
    }
  }
}

export async function openMBTiles(blob) {
  const pager = new Pager(blob);
  await pager.init();
  const db = new Db(pager);

  const objects = {};
  await db.walkTable(1, (_id, r) => { objects[`${r[0]}:${r[1]}`] = { name: r[1], tbl: r[2], root: r[3], sql: r[4] || '' }; });
  const tilesObj = objects['table:tiles'];
  if (!tilesObj) {
    if (objects['view:tiles']) {
      throw new Error('Questo MBTiles usa una struttura "deduplicata" (tiles come vista) non ancora supportata. Rigeneralo con QGIS o Mobile Atlas Creator.');
    }
    throw new Error('Nel file non c\'è la tabella "tiles": non è un MBTiles.');
  }

  const meta = {};
  const metaObj = objects['table:metadata'];
  if (metaObj) await db.walkTable(metaObj.root, (_id, r) => { meta[r[0]] = r[1]; });
  const format = String(meta.format || '').toLowerCase();
  if (format === 'pbf' || format === 'mvt') {
    throw new Error('Questa è una mappa vettoriale (pbf). Per ora sono supportate solo mappe raster (png/jpg/webp).');
  }

  const withoutRowid = /without\s+rowid/i.test(tilesObj.sql);
  let idxRoot = 0;
  if (!withoutRowid) {
    for (const o of Object.values(objects)) {
      if (o.tbl === 'tiles' && /\(\s*"?zoom_level"?\s*,\s*"?tile_column"?\s*,\s*"?tile_row"?/i.test(o.sql) && o.root) { idxRoot = o.root; break; }
    }
  }

  // Senza indice: scansione completa una volta sola (più lenta ma funziona).
  let scanMap = null, scanP = null;
  function scan() {
    if (!scanP) {
      const m = new Map();
      scanP = db.walkTable(tilesObj.root, (rowid, r) => { m.set(`${r[0]}/${r[1]}/${r[2]}`, rowid); }).then(() => { scanMap = m; });
    }
    return scanP; // tutte le richieste aspettano la stessa scansione
  }

  const nums = (s) => (s ? String(s).split(',').map(Number) : null);
  const info = {
    name: meta.name || '',
    format: format || 'png',
    bounds: nums(meta.bounds),   // [west, south, east, north]
    center: nums(meta.center),   // [lon, lat, zoom]
    minzoom: meta.minzoom != null ? Number(meta.minzoom) : 0,
    maxzoom: meta.maxzoom != null ? Number(meta.maxzoom) : 18,
  };

  // Schema XYZ (come nelle mappe web); MBTiles usa internamente la riga TMS.
  async function getTile(z, x, y) {
    const row = (1 << z) - 1 - y;
    if (withoutRowid) {
      const r = await db.indexFind(tilesObj.root, [z, x, row]);
      return r ? r[3] : null;
    }
    if (idxRoot) {
      const r = await db.indexFind(idxRoot, [z, x, row]);
      if (!r) return null;
      const full = await db.getRow(tilesObj.root, r[r.length - 1]);
      return full ? full[3] : null;
    }
    await scan();
    const id = scanMap.get(`${z}/${x}/${row}`);
    if (id == null) return null;
    const full = await db.getRow(tilesObj.root, id);
    return full ? full[3] : null;
  }

  return { info, getTile };
}
