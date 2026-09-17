'use strict';

/**
 * Self-contained EPUB parser — no dependencies.
 *
 * EPUB is a ZIP of XHTML chapters. We parse the ZIP central directory by hand
 * (stored + deflate via Node's built-in zlib), read container.xml → OPF →
 * spine order, and flatten each chapter into reading blocks:
 *   {t:'l', text}          a reading line
 *   {t:'img', src}         inline image as data: URI
 * plus per-chapter footnote notes: [{id, text}] and marker-to-note references.
 * String/regex based (no DOM) so malformed real-world epubs don't blow up.
 */

const zlib = require('zlib');

// ---------------------------------------------------------------- ZIP reading

function findEocd(buf) {
  const SIG = 0x06054b50;
  const start = Math.max(0, buf.length - 65557); // max EOCD + comment
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  return -1;
}

function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 EPUB/ZIP 文件（找不到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central dir signature
    entries.set(buf.slice(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString('utf8'), {
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      lho: buf.readUInt32LE(p + 42),
    });
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const lho = entry.lho;
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
  const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return data;                     // stored
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error('不支持的 ZIP 压缩方式: ' + entry.method);
}

// ---------------------------------------------------------------- helpers

function resolvePath(baseDir, ref) {
  const cleaned = decodeURIComponent(String(ref).trim().split('#')[0]);
  if (/^(https?:|data:|mailto:)/i.test(cleaned)) return String(ref);
  const parts = (baseDir ? baseDir.split('/') : []).concat(cleaned.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function safeCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch (_) { return ''; }
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', middot: '·', bull: '•',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const rep = NAMED_ENTITIES[name.toLowerCase()];
      return rep !== undefined ? rep : m;
    });
}

function attr(tag, name) {
  let m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
  if (m) return m[1];
  m = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*'([^']*)'").exec(tag);
  return m ? m[1] : '';
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

function imgMime(path) {
  return MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

function isGenericDocumentTitle(title) {
  return /^(?:text|part|chapter|section|content|index|file)[_\s-]*\d*(?:[_\s-]*(?:split|part)[_\s-]*\d+)?\.x?html?$/i.test(title);
}

function isUnusableDocumentTitle(title) {
  return !title || isGenericDocumentTitle(title) || /^(?:未知|无标题|unknown|untitled)$/i.test(title.trim());
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ''));
}

/** Return a numeric footnote label from the common EPUB display conventions. */
function noteNumber(label) {
  const text = decodeEntities(label).replace(/\s+/g, '').trim();
  let m = /^[\[（(]?([0-9]{1,3})[\]）)]?$/.exec(text);
  if (m) return m[1];
  const superscript = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}$/.test(text)) return [...text].map(c => superscript[c]).join('');
  const cp = text.codePointAt(0);
  if ([...text].length === 1 && cp >= 0x2460 && cp <= 0x2473) return String(cp - 0x2460 + 1); // ①–⑳
  return '';
}

/** html fragment → plain reading lines (block tags end lines). */
function htmlToLines(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|figcaption|aside|header|footer|main|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\n+/)
    .map(l => decodeEntities(l).replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0);
}

/**
 * Extract footnote-ish notes: elements with an id (aside/li/p/span/a/footer) whose
 * inner text is short. For tiny inline markers (back-ref `<a id=x>[2]</a>`), extend
 * with the text that follows inside the enclosing block.
 */
function extractNotes(html) {
  const notes = [];
  const seen = new Set();
  const add = (id, text) => {
    if (!id || seen.has(id) || !text || text.length < 2) return;
    seen.add(id);
    notes.push({ id, text });
  };
  // Publishers use both EPUB 2's <div>/<li> and EPUB 3's <section
  // epub:type="footnote">. Keep this deliberately tag-agnostic within the
  // usual text containers; a page may have lots of ids, so the checks below
  // still prevent normal long body sections being mistaken for notes.
  const re = /<(aside|li|p|span|a|footer|div|section|article|dd|dt)\b([^>]*)\bid\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[3];
    if (seen.has(id)) continue;
    let text = stripTags(m[5]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const attrs = (m[2] + ' ' + m[4]).toLowerCase();
    const tag = m[1].toLowerCase();
    const isFootnotey =
      /footnote|noteref|endnote|rearnote|annotation/.test(attrs) ||
      tag === 'aside' ||
      tag === 'footer';
    if (text.length < 12 && /a|span/.test(tag)) {
      // back-ref marker: grab following text in the same block
      const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const stop = tail.search(/<\/(p|li|div|aside|footer)>/i);
      const extra = stripTags(stop >= 0 ? tail.slice(0, stop) : tail).replace(/\s+/g, ' ').trim();
      if (extra.length > text.length) text = text + ' ' + extra;
    }
    if (text.length < 2) continue;
    if (!isFootnotey && text.length > 400) continue; // long non-note blocks are body text
    // Do not truncate actual notes. Classical-book EPUBs often contain long annotations.
    add(id, text);
  }

  // Calibre-generated Chinese EPUBs commonly use this shape:
  //   <p class="note"><a id="m1"></a><a href="#w1">[1]</a> 注释正文</p>
  // The anchor that owns the fragment id is intentionally empty, so the loop
  // above cannot use it. Associate every nested id with its note-like block.
  {
    const blockRe = /<(aside|li|p|div|section|article|dd|dt)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let block;
    while ((block = blockRe.exec(html)) !== null) {
      const attrs = block[2].toLowerCase();
      if (!/footnote|endnote|rearnote|annotation|\bnotes?\b/.test(attrs)) continue;
      const text = stripTags(block[3]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const ids = block[3].matchAll(/\bid\s*=\s*["']([^"']+)["']/gi);
      for (const idMatch of ids) add(idMatch[1], text);
    }
  }
  return notes;
}

/** Map visible numeric markers to their actual XHTML fragment targets. */
function extractNoteRefs(html, notes, resolveNote) {
  const noteById = new Map(notes.map(note => [note.sourceId || note.id, note]));
  const refs = Object.create(null);
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = attr(m[1], 'href');
    const hash = href.lastIndexOf('#');
    if (hash < 0) continue;
    const target = decodeURIComponent(href.slice(hash + 1));
    let note = resolveNote ? resolveNote(href) : noteById.get(target);
    const localNote = noteById.get(target);
    // A self-link can be written as either "#m1" or "chapter.xhtml#m1".
    // Retain the local object in that case, while avoiding a false match when
    // another notes file happens to reuse the same id.
    if (note && localNote && note.text === localNote.text) note = localNote;
    if (!note) note = localNote;
    if (!note) continue;
    // Make an external note available to this chapter without removing its
    // source block from the chapter currently being rendered.
    if (!notes.includes(note)) notes.push({ ...note, local: false });
    const label = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    const marker = noteNumber(label);
    if (marker && !refs[marker]) refs[marker] = note.id;
  }
  return refs;
}

/** Convert recognised linked superscripts / bare digits to the reader's [n] form. */
function normalizeNoteMarkers(html, resolveNote) {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const href = attr(attrs, 'href');
    if (!href || href.lastIndexOf('#') < 0 || !resolveNote || !resolveNote(href)) return whole;
    const n = noteNumber(stripTags(inner));
    return n ? `<a${attrs}>[${n}]</a>` : whole;
  });
}

/** Remove identified note blocks before turning the chapter into reading text. */
function removeNotesFromBody(html, notes) {
  const noteIds = new Set(notes.filter(note => note.local !== false).map(note => note.sourceId || note.id));
  if (!noteIds.size) return html;
  return html.replace(
    /<(aside|li|p|span|a|footer|div|section|article|dd|dt)\b([^>]*)>[\s\S]*?<\/\1>/gi,
    (whole, _tag, attrs) => noteIds.has(attr(attrs, 'id')) ? ' ' : whole,
  );
}

/** Extract NCX navigation labels keyed by the target XHTML path. */
function extractNcxTitles(ncx, baseDir) {
  const titles = new Map();
  const re = /<navPoint\b[^>]*>[\s\S]*?<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(ncx)) !== null) {
    const label = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    const target = resolvePath(baseDir, m[2]);
    if (label && target && !titles.has(target)) titles.set(target, label);
  }
  return titles;
}

/**
 * XHTML chapter → { title, blocks, notes }.
 * blocks: {t:'l',text} | {t:'img',src} — images split the text flow.
 */
function xhtmlToBlocks(html, resolveImg, resolveNote) {
  let title = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tm) title = stripTags(tm[1]).replace(/\s+/g, ' ').trim();
  // Many converter-produced EPUBs use titles such as "text00007.html" for
  // every XHTML file. They are implementation filenames, not useful table of
  // contents labels; prefer the first visible heading in that case.
  if (isUnusableDocumentTitle(title)) {
    const hm = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
    if (hm) {
      const heading = stripTags(hm[1]).replace(/\s+/g, ' ').trim();
      if (heading) title = heading;
    }
  }

  const notes = extractNotes(html);
  const noteRefs = extractNoteRefs(html, notes, resolveNote);

  let s = removeNotesFromBody(normalizeNoteMarkers(html, resolveNote), notes)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const blocks = [];
  // split the flow on <img> / <image> tags so each becomes its own block
  const parts = s.split(/(<img\b[^>]*>|<image\b[^>]*>)/gi);
  for (const part of parts) {
    if (/^<img\b|^<image\b/i.test(part)) {
      const ref = attr(part, 'src') || attr(part, 'xlink:href') || attr(part, 'href');
      if (ref && !/^(https?:|data:)/i.test(ref)) {
        const src = resolveImg ? resolveImg(ref) : null;
        if (src) blocks.push({ t: 'img', src });
      }
      continue;
    }
    for (const line of htmlToLines(part)) blocks.push({ t: 'l', text: line });
  }
  return { title, blocks, notes, noteRefs };
}

// ---------------------------------------------------------------- EPUB parse

/**
 * @param {Buffer} buffer raw .epub bytes
 * @returns {{ title, chapters: Array<{title, blocks, notes, lines:number }> }}
 */
function parseEpub(buffer) {
  const entries = listZipEntries(buffer);
  const entryOf = (name) => {
    if (entries.has(name)) return entries.get(name);
    for (const k of entries.keys()) if (k.toLowerCase() === name.toLowerCase()) return entries.get(k);
    return undefined;
  };
  const get = (name) => {
    const e = entryOf(name);
    return e ? readZipEntry(buffer, e) : null;
  };

  const container = get('META-INF/container.xml');
  if (!container) throw new Error('不是有效的 EPUB（缺少 META-INF/container.xml）');
  const opfPathMatch = /full-path="([^"]+)"/.exec(container.toString('utf8'));
  if (!opfPathMatch) throw new Error('container.xml 未指向 OPF 文件');
  const opfPath = decodeURIComponent(opfPathMatch[1]);
  const opfBuf = get(opfPath);
  if (!opfBuf) throw new Error('找不到 OPF: ' + opfPath);
  const opf = opfBuf.toString('utf8');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const bookTitle = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  const items = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id');
    const href = attr(m[0], 'href');
    if (!id || !href) continue;
    items.set(id, {
      href,
      media: attr(m[0], 'media-type') || '',
      props: (attr(m[0], 'properties') || '').toLowerCase(),
    });
  }

  const ncxItem = [...items.values()].find(item => /ncx/i.test(item.media));
  const ncxTitles = ncxItem ? extractNcxTitles(
    (get(resolvePath(opfDir, ncxItem.href)) || Buffer.alloc(0)).toString('utf8'), opfDir,
  ) : new Map();

  const resolveImg = (ref) => {
    const p = resolvePath(opfDir, ref);
    // try relative to OPF dir first, then as-is (chapter-relative refs come pre-resolved
    // by the caller passing the chapter dir — handled below via closure)
    const buf = get(p) || get(ref);
    if (!buf) return null;
    return `data:${imgMime(p || ref)};base64,${buf.toString('base64')}`;
  };

  // Read the spine first. Footnotes are frequently collected in a separate
  // notes.xhtml file, so resolving while processing one chapter is too late.
  const spine = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const it = items.get(attr(m[0], 'idref'));
    if (!it) continue;
    if (it.props.split(/\s+/).includes('nav')) continue;
    if (it.media && !/x?html/i.test(it.media)) continue;
    const filePath = resolvePath(opfDir, it.href);
    const file = get(filePath);
    if (!file) continue;
    spine.push({ filePath, href: it.href, html: file.toString('utf8') });
  }

  const notesByTarget = new Map();
  for (const item of spine) {
    for (const note of extractNotes(item.html)) {
      const key = item.filePath + '#' + note.id;
      notesByTarget.set(key, { ...note, id: key, sourceId: note.id, local: true });
    }
  }

  const chapters = [];
  for (const item of spine) {
    const { filePath } = item;
    const chDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : opfDir;
    const resolveNote = (href) => {
      const hash = href.lastIndexOf('#');
      if (hash < 0) return null;
      const id = decodeURIComponent(href.slice(hash + 1));
      const refPath = href.slice(0, hash);
      const targetPath = refPath ? resolvePath(chDir, refPath) : filePath;
      return notesByTarget.get(targetPath + '#' + id) || null;
    };
    const { title, blocks, notes, noteRefs } = xhtmlToBlocks(item.html, (ref) => {
      const p = resolvePath(chDir, ref);
      const buf = get(p) || get(resolvePath(opfDir, ref));
      if (!buf) return null;
      return `data:${imgMime(p)};base64,${buf.toString('base64')}`;
    }, resolveNote);
    const lines = blocks.reduce((n, b) => n + (b.t === 'l' ? 1 : 0), 0);
    if (!blocks.length) continue;
    const navTitle = ncxTitles.get(filePath);
    const displayTitle = isUnusableDocumentTitle(title) ? (navTitle || title) : title;
    chapters.push({
      title: displayTitle || item.href, blocks, notes, noteRefs, lines,
      // Keep the spine document readable, but let the UI distinguish entries
      // deliberately published in the book's navigation from auxiliary pages.
      tocListed: ncxTitles.has(filePath),
    });
  }
  if (!chapters.length) throw new Error('EPUB 里没有可读的章节内容');

  return { title: bookTitle, chapters };
}

module.exports = {
  parseEpub, xhtmlToBlocks, extractNotes, extractNoteRefs, removeNotesFromBody,
  normalizeNoteMarkers, noteNumber, extractNcxTitles,
  resolvePath, decodeEntities, stripTags,
};
