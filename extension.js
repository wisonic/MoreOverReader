'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseEpub } = require('./epub');
const { buildFrame, wrapText } = require('./frame');
const { buildFake, buildAfter } = require('./fake');
const { ShelfProvider } = require('./shelf');

const START = Date.now();

function decodeBuffer(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('gb18030').decode(buf); } catch (_) { return utf8; }
}

function buildBook(filePath, bookTitle, chapters) {
  const flat = [];
  const chs = [];
  const cfg = vscode.workspace.getConfiguration('moreoverReader');
  const cols = cfg.get('columns', 82);
  chapters.forEach(ch => {
    const start = flat.length;
    flat.push({ t: 'l', text: '# ' + ch.title, head: true });
    ch.blocks.forEach(b => {
      if (b.t === 'l') {
        // pre-wrap each paragraph to reading lines so every visual row is complete
        wrapText(b.text, cols).forEach(piece => flat.push({ t: 'l', text: piece }));
      } else {
        flat.push(b);
      }
    });
    chs.push({
      title: ch.title, start, end: flat.length,
      notes: ch.notes || [], noteRefs: ch.noteRefs || {},
      tocListed: !!ch.tocListed,
    });
  });
  // The spine can include cover, copyright and colophon XHTML files. If the
  // EPUB supplies a formal NCX/nav table of contents, use it for `j`; otherwise
  // retain the old, useful fallback of listing every readable chapter.
  const hasOfficialToc = chs.some(ch => ch.tocListed);
  const toc = hasOfficialToc ? chs.filter(ch => ch.tocListed) : chs;
  return { filePath, title: bookTitle || path.basename(filePath), flat, chapters: chs, toc, total: flat.length };
}

async function loadBookFromDisk(filePath) {
  if (/\.epub$/i.test(filePath)) {
    const { title, chapters } = parseEpub(fs.readFileSync(filePath));
    return buildBook(filePath, title, chapters);
  }
  const text = decodeBuffer(fs.readFileSync(filePath));
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0).map(s => ({ t: 'l', text: s }));
  if (!lines.length) throw new Error('文件里没有可读内容');
  return buildBook(filePath, '', [{ title: '正文', blocks: lines, notes: [] }]);
}

function chapterOf(book, line) {
  let lo = 0, hi = book.chapters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (book.chapters[mid].start <= line) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function markersIn(text) {
  const out = [];
  const re = /([[(（])(\d{1,3})([\])）])/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

/** The reading "terminal" — a Pseudoterminal. handleInput() receives every key. */
class BookTerminal {
  constructor(onKey) {
    this.onKey = onKey;
    this.writeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.render = (frame) => this.writeEmitter.fire(frame);
  }
  open() {}
  close() {}
  handleInput(data) {
    // decode printable single chars + a few control sequences
    for (const ch of data) {
      if (/^[a-zA-Z0-9]$/.test(ch)) this.onKey(ch);
    }
    if (data === '\r' || data === '\n') this.onKey('Enter');
    if (data === ' ') this.onKey('space');
    if (data === '[C') this.onKey('Right');
    if (data === '[D') this.onKey('Left');
    if (data === '[A') this.onKey('Up');
    if (data === '[B') this.onKey('Down');
    if (data === '' || data === '\b') this.onKey('Backspace');
  }
}

function activate(context) {
  const S = {
    book: null, line: 0,
    visible: false,          // book text hidden until first key (stealth default)
    notes: [], notesVisible: false,
    tick: 0, term: null, pty: null,
    imgPanel: null, imgTimer: null, autoTimer: null,
    books: {},
  };
  Object.assign(S.books, context.workspaceState.get('moreover.books', {}));
  const shelf = new ShelfProvider(() => S.books, p => loadBook(p));

  function saveBooks() {
    if (S.book) S.books[S.book.filePath] = { line: S.line };
    context.workspaceState.update('moreover.books', S.books);
    shelf.refresh();
  }

  function chapterHint() {
    if (!S.book) return '';
    const i = chapterOf(S.book, S.line);
    return `${i + 1}/${S.book.chapters.length} · ${S.book.chapters[i].title}`.slice(0, 40);
  }

  function render() {
    if (!S.pty) return;
    const cfg = vscode.workspace.getConfiguration('moreoverReader');
    S.pty.render(buildFrame({
      fake: buildFake(S.tick),
      book: S.book, line: S.line, visible: S.visible,
      lines: cfg.get('lines', 3),
      chapter: chapterHint(),
      notes: S.notes, notesVisible: S.notesVisible,
      afterText: buildAfter(S.tick),
      elapsedMs: Date.now() - START,
      cost: '16.17', model: 'opus-4.8[1m]',
    }));
  }

  function status(msg) { vscode.window.setStatusBarMessage('Moreover: ' + msg, 1500); }

  function hide() { if (S.visible) { S.visible = false; render(); } }

  // ---------------------------------------------------------- image popup
  function closeImage() {
    clearTimeout(S.imgTimer);
    S.imgTimer = null;
    const panel = S.imgPanel;
    // Clear this synchronously: onDidDispose can arrive after another preview
    // has opened, and must not affect that newer panel or its timer.
    S.imgPanel = null;
    if (panel) panel.dispose();
  }

  function showImage(hold) {
    // toggle: if already open, pressing i again closes it
    if (S.imgPanel) { closeImage(); return; }
    if (!S.book) return;
    let i = S.line;
    while (i >= 0 && (!S.book.flat[i] || S.book.flat[i].t !== 'img')) i--;
    if (i < 0) return status('附近没有插图');
    const src = S.book.flat[i].src;
    const panel = vscode.window.createWebviewPanel(
      'moreoverReader.image', 'Preview',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: true },
    );
    S.imgPanel = panel;
    panel.onDidDispose(() => {
      if (S.imgPanel !== panel) return;
      S.imgPanel = null;
      clearTimeout(S.imgTimer);
      S.imgTimer = null;
    });
    panel.webview.onDidReceiveMessage(message => {
      if (message && message.type === 'closeImage' && S.imgPanel === panel) closeImage();
    });
    panel.webview.html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh}' +
      'img{max-width:100%;max-height:100%}</style></head><body><img src="' + src + '">' +
      '<script>const v=acquireVsCodeApi();addEventListener("keydown",e=>{if(e.key.toLowerCase()==="i"){e.preventDefault();v.postMessage({type:"closeImage"})}})</script></body></html>';
    // A webview can steal the terminal's input focus on some VS Code versions
    // despite preserveFocus. Return focus explicitly so a second `i` reaches
    // the Pseudoterminal and toggles this panel off immediately.
    if (S.term) S.term.show();
    clearTimeout(S.imgTimer);
    if (!hold) S.imgTimer = setTimeout(() => { if (S.imgPanel === panel) closeImage(); }, 3000);
  }

  // ---------------------------------------------------------- paging
  function step(d) {
    if (!S.book) return;
    const n = S.line + d;
    if (n < 0 || n >= S.book.total) return status('已到书的边界');
    // n/p stepping keeps the fake transcript byte-identical so ONLY the book text
    // (and progress) visibly change; jumps/chapters rotate it.
    S.line = n; S.notesVisible = false;
    saveBooks(); render();
  }

  /** Move a whole visible text window. Used by n/p; arrows remain line-by-line. */
  function page(d) {
    if (!S.book) return;
    const cfg = vscode.workspace.getConfiguration('moreoverReader');
    const rows = cfg.get('lines', 3);
    const target = Math.max(0, Math.min(S.book.total - 1, S.line + d * rows));
    if (target === S.line) return status('已到书的边界');
    step(target - S.line);
  }

  function chapter(d) {
    if (!S.book) return;
    const ci = chapterOf(S.book, S.line);
    const t = S.book.chapters[ci + d];
    if (!t) return status('已到章节边界');
    S.line = d > 0 ? t.start : Math.max(0, t.end - 1);
    S.notesVisible = false; S.tick++;
    saveBooks(); render();
  }

  /** Collect notes for every [n]-marker in the visible window. */
  function windowNotes() {
    if (!S.book) return [];
    const cfg = vscode.workspace.getConfiguration('moreoverReader');
    const win = cfg.get('lines', 3);
    const from = Math.max(0, S.line - win + 1);
    const found = [];
    const seen = new Set();
    for (let i = from; i <= S.line; i++) {
      const b = S.book.flat[i];
      if (!b || b.t !== 'l') continue;
      for (const n of markersIn(b.text)) {
        if (seen.has(n)) continue;
        const ch = S.book.chapters[chapterOf(S.book, i)];
        // EPUB noterefs point at the exact note with href="#id". Prefer that
        // relationship over text/id heuristics, which can pair the wrong note.
        let note = ch.noteRefs[n] && ch.notes.find(x => x.id === ch.noteRefs[n]);
        // Fallbacks retain compatibility with EPUBs that contain only plain [n]
        // markers, without an anchor relationship.
        if (!note) note = ch.notes.find(x =>
          new RegExp('^[\\[（(]\\s*' + n + '\\s*[\\]）)]').test(x.text));
        if (!note) note = ch.notes.find(x => new RegExp('note' + n + '$', 'i').test(x.id));
        if (note) { seen.add(n); found.push({ n, text: note.text }); }
      }
    }
    return found;
  }

  function toggleNotes() {
    if (S.notesVisible) { S.notesVisible = false; render(); return; }
    const notes = windowNotes();
    if (!notes.length) return status('当前窗口没有注解标记');
    S.notes = notes;
    S.notesVisible = true;
    render();
  }

  let autoOn = false;
  function toggleAuto() {
    autoOn = !autoOn;
    clearInterval(S.autoTimer);
    if (autoOn) S.autoTimer = setInterval(() => { S.visible = true; step(1); }, 3000);
    status(autoOn ? '自动滚动开（3s/行）' : '自动滚动关');
  }

  function stop() {
    clearInterval(S.autoTimer); autoOn = false;
    saveBooks();
    S.book = null; S.visible = false;
    render();
    if (S.term) { S.term.dispose(); S.term = null; S.pty = null; }
    closeImage();
    status('已停止阅读');
  }

  // ---------------------------------------------------------- key dispatch
  function onKey(k) {
    switch (k) {
      case 'd': S.visible = !S.visible; render(); break;
      // All reading-navigation keys replace the current window as a whole.
      case 'n': case 'Down': case 'space': case 'Enter': if (S.visible) page(1); break;
      case 'p': case 'Up': if (S.visible) page(-1); break;
      case 'j': if (S.visible) jumpChapter(); break;
      case 'e': if (S.visible) toggleNotes(); break;
      case 'i': showImage(false); break;
      case 'I': showImage(true); break;
      case 'l': case 'Right': if (S.visible) chapter(1); break;
      case 'h': case 'Left': if (S.visible) chapter(-1); break;
      case 'a': toggleAuto(); break;
      case 'q': S.visible = false; render(); break;
      case 'Q': stop(); break;
    }
  }

  /** j = jump: open the book's table of contents (QuickPick) and jump there. */
  async function jumpChapter() {
    if (!S.book) return;
    const current = chapterOf(S.book, S.line);
    const entries = S.book.toc && S.book.toc.length ? S.book.toc : S.book.chapters;
    const picked = await vscode.window.showQuickPick(
      entries.map((c, i) => ({
        label: `${String(i + 1).padStart(3)} · ${c.title.slice(0, 48)}`,
        description: c === S.book.chapters[current] ? '当前章' : '',
        chapter: c,
      })),
      { placeHolder: `目录 · ${entries.length} 章（跳转到…）`, matchOnDescription: false },
    );
    if (!picked) return;                       // Esc: back to reading, terminal keeps focus
    S.line = picked.chapter.start;
    S.notesVisible = false; S.tick++;
    saveBooks(); render();
  }

  function ensureTerminal() {
    if (S.term) return S.term.show();
    S.pty = new BookTerminal(onKey);
    S.term = vscode.window.createTerminal({ name: 'claude', pty: S.pty, hideFromUser: false });
    S.term.show();
    context.subscriptions.push({ dispose: () => { try { S.term && S.term.dispose(); } catch (_) {} } });
    // blur → auto hide. Cover every path away from the reading terminal:
    // another terminal, an editor becoming visible, cursor moved into an editor
    // (clicking the already-active editor fires no "active editor changed" event),
    // or the whole VS Code window losing focus.
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal(t => { if (t !== S.term) hide(); }),
      vscode.window.onDidChangeActiveTextEditor(ed => { if (ed) hide(); }),
      vscode.window.onDidChangeTextEditorSelection(e => { if (e.textEditor) hide(); }),
      vscode.window.onDidChangeWindowState(ws => { if (!ws.focused) hide(); }),
    );
    render();
  }

  async function loadBook(fsPath) {
    let book;
    try { book = await loadBookFromDisk(fsPath); }
    catch (e) { return vscode.window.showErrorMessage('Moreover: ' + e.message); }
    S.book = book;
    S.line = Math.min((S.books[fsPath] && S.books[fsPath].line) || 0, book.total - 1);
    S.notes = []; S.notesVisible = false; S.visible = true;
    ensureTerminal();
    saveBooks(); render();
    status(`《${book.title}》 ${book.chapters.length}章 · j 目录 · e 注解 · i 插图`);
  }

  async function removeBookByPath(fsPath) {
    const name = path.basename(fsPath);
    const ok = await vscode.window.showWarningMessage(
      `移除《${name}》？阅读进度会一起删除`, { modal: true }, '移除',
    );
    if (!ok) return;
    delete S.books[fsPath];
    if (S.book && S.book.filePath === fsPath) stop();
    await context.workspaceState.update('moreover.books', S.books);
    shelf.refresh();
    status('已移除《' + name + '》');
  }

  async function openBook() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Books': ['epub', 'txt'] } });
    if (uris && uris.length) await loadBook(uris[0].fsPath);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('moreoverReader.openBook', openBook);
  reg('moreoverReader.openPath', p => loadBook(p));
  reg('moreoverReader.removeBook', async () => {
    const known = Object.keys(S.books);
    if (!known.length) return vscode.window.showInformationMessage('Moreover: 书架是空的');
    const picked = await vscode.window.showQuickPick(
      known.map(p => ({ label: path.basename(p), description: p, path: p })), { placeHolder: '移除哪本书？' });
    if (!picked) return;
    await removeBookByPath(picked.path);
  });
  // right-click "移除" on a shelf item
  reg('moreoverReader.removeShelfItem', (item) => removeBookByPath(item && item.path));

  context.subscriptions.push(vscode.window.registerTreeDataProvider('moreoverReader.shelf', shelf));
}

function deactivate() {}

module.exports = { activate, deactivate };
