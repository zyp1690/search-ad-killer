/**
 * test/harness.js
 * 轻量 DOM / Chrome API 模拟环境，用于在 Node 中真实运行
 * options.js、popup.js、content.js、service-worker.js。
 *
 * 与 smoke.js 的区别：smoke.js 的 DOM 只够跑 content.js，
 * 而本模块补齐了 options/popup 所需的事件派发、classList、value、hidden 等能力，
 * 从而可以真正执行这些模块的代码路径（而非在测试里复写其逻辑）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ============================================================
 * 选择器引擎
 * 支持：tag、#id、.class、[attr]、[attr="v"]、[attr*="v"]、后代组合、逗号组合
 * 不支持：> :has() :not() 伪类（返回 false 以避免误判）
 * ========================================================== */

function matchOne(el, sel) {
  if (!sel) return false;
  if (sel.includes('::')) return false;
  const m = /^(.*?)((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const tag = m[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const tokens = (m[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  for (const tk of tokens) {
    if (tk[0] === '#') {
      if (el.id !== tk.slice(1)) return false;
    } else if (tk[0] === '.') {
      if (!el.classList.contains(tk.slice(1))) return false;
    } else {
      // 属性名可含连字符（data-site）。采用两段式解析，避免引号可选的正则失配。
      const inner = tk.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) {
        // 无 "=" → 仅要求属性存在
        const exists = inner in el.attributes
          || (inner.startsWith('data-') && inner.slice(5) in el.dataset);
        if (!exists) return false;
      } else {
        const key = inner.slice(0, eq).trim();
        let val = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

        // 仅当首个字符是合法运算符时才剥离，否则它属于值本身（如 [data-site=go]）
        let op = '=';
        if (val.length > 1 && '*^$~|'.indexOf(val[0]) !== -1) {
          op = val[0] + '=';
          val = val.slice(1);
        }

        const raw = key in el.attributes ? el.attributes[key]
          : (key.startsWith('data-') && key.slice(5) in el.dataset ? el.dataset[key.slice(5)] : undefined);
        if (raw === undefined) return false;
        const s = String(raw);
        if (op === '=' && s !== val) return false;
        if (op === '*=' && !s.includes(val)) return false;
        if (op === '^=' && !s.startsWith(val)) return false;
        if (op === '$=' && !s.endsWith(val)) return false;
        if (op === '~=' && !s.split(/\s+/).includes(val)) return false;
      }
    }
  }
  return true;
}

function matchCompound(el, sel) {
  if (!sel) return false;
  if (!/[\s>]/.test(sel)) return matchOne(el, sel);
  const parts = sel.split(/\s+/).filter(Boolean);
  if (parts.some((p) => p === '>' || p.includes(':'))) return false;
  // 先匹配最后一段（自身）
  if (!matchOne(el, parts[parts.length - 1])) return false;

  // 从自身父节点开始，逐段向上回溯匹配剩余部分
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    let found = null;
    while (node) {
      if (matchOne(node, part)) { found = node; break; }
      node = node.parentElement;
    }
    if (!found) return false;
    // 下一段应从本段匹配到的节点的父节点继续
    node = found.parentElement;
  }
  return true;
}

/* ============================================================
 * Element
 * ========================================================== */
class El {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.attributes = {};
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this._text = '';
    this._listeners = {};
    // 表单属性
    this.checked = false;
    this.value = '';
    this.indeterminate = false;
    this.hidden = false;
    this.disabled = false;
    this.type = '';

    const self = this;
    this.classList = {
      contains(c) { return String(self.attributes.class || '').split(/\s+/).filter(Boolean).includes(c); },
      add(...cs) {
        const set = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean));
        cs.forEach((c) => set.add(c));
        self.attributes.class = Array.from(set).join(' ');
      },
      remove(...cs) {
        const set = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean));
        cs.forEach((c) => set.delete(c));
        self.attributes.class = Array.from(set).join(' ');
      },
      toggle(c, force) {
        const has = this.contains(c);
        const want = force === undefined ? !has : !!force;
        if (want) this.add(c); else this.remove(c);
        return want;
      }
    };

    this.style = {
      props: {},
      setProperty(k, v, prio) { this.props[k] = prio ? v + '!' + prio : v; this._writeStyle(); },
      getPropertyValue(k) { return this.props[k] || ''; },
      removeProperty(k) { const v = this.props[k]; delete this.props[k]; this._writeStyle(); return v || ''; },
      set height(v) { this.setProperty('height', v); }, get height() { return this.props.height || ''; },
      set overflow(v) { this.setProperty('overflow', v); }, get overflow() { return this.props.overflow || ''; },
      set display(v) { this.setProperty('display', v); }, get display() { return this.props.display || ''; },
      set width(v) { this.setProperty('width', v); }, get width() { return this.props.width || ''; }
    };
    this.style._writeStyle = () => {
      this.attributes.style = Object.keys(this.style.props)
        .map((k) => `${k}: ${this.style.props[k]};`).join(' ');
    };

    Object.keys(attrs).forEach((k) => this.setAttribute(k, attrs[k]));
  }

  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = v; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
    if (k === 'style') this._parseStyle(String(v));
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k.startsWith('data-')) delete this.dataset[k.slice(5)];
    if (k === 'style') this.style.props = {};
  }
  hasAttribute(k) { return k in this.attributes; }
  _parseStyle(str) {
    this.style.props = {};
    String(str).split(';').forEach((d) => {
      const i = d.indexOf(':');
      if (i === -1) return;
      const k = d.slice(0, i).trim();
      let v = d.slice(i + 1).trim();
      const imp = /!important$/i.test(v);
      if (imp) v = v.replace(/!important$/i, '').trim();
      this.style.props[k] = imp ? v + '!important' : v;
    });
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }

  get innerHTML() { return this._html || ''; }
  set innerHTML(v) {
    // 极简解析：只处理 <tag id="x" class="y">文本</tag>，够用即可
    this.childNodes = [];
    this._text = '';
    this._html = String(v == null ? '' : v);
    const re = /<(\w+)([^>]*)>(.*?)<\/\1>/g;
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const [, tag, attrs, text] = m;
      const node = new El(tag);
      const aRe = /([\w-]+)="([^"]*)"/g;
      let am;
      while ((am = aRe.exec(attrs)) !== null) node.setAttribute(am[1], am[2]);
      node.textContent = text;
      this.appendChild(node);
    }
  }

  appendChild(c) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(n, ref) {
    if (n.parentElement) n.parentElement.removeChild(n);
    n.parentElement = this;
    const i = this.childNodes.indexOf(ref);
    if (i === -1) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) this.childNodes.splice(i, 1);
    n.parentElement = null;
    return n;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }

  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.childNodes, i = a.indexOf(this);
    for (let j = i - 1; j >= 0; j--) if (a[j].nodeType === 1) return a[j];
    return null;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.childNodes, i = a.indexOf(this);
    for (let j = i + 1; j < a.length; j++) if (a[j].nodeType === 1) return a[j];
    return null;
  }
  get firstElementChild() { return this.children[0] || null; }

  matches(sel) { return String(sel).split(',').some((s) => matchCompound(this, s.trim())); }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      n.childNodes.forEach((c) => {
        if (c.nodeType !== 1) return;
        if (c.matches(sel)) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  /* ---- 事件 ---- */
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  }
  dispatchEvent(evt) {
    const e = Object.assign({
      target: this,
      preventDefault() { e.defaultPrevented = true; },
      stopPropagation() { e._stopped = true; },
      defaultPrevented: false
    }, evt);
    let cur = this;
    while (cur) {
      e.currentTarget = cur;
      (cur._listeners[e.type] || []).slice().forEach((fn) => {
        if (!e._stopped) fn.call(cur, e);
      });
      cur = e.bubbles === false ? null : cur.parentElement;
      if (e._stopped) break;
    }
    return !e.defaultPrevented;
  }
  /** 便捷方法：模拟用户点击 */
  click() { return this.dispatchEvent({ type: 'click', bubbles: true }); }
  /** 模拟 change 事件（checkbox/radio/select 变更） */
  change() { return this.dispatchEvent({ type: 'change', bubbles: true }); }
  input() { return this.dispatchEvent({ type: 'input', bubbles: true }); }
  /* 无副作用的交互桩，仅为让被测代码能跑通 */
  focus() { this._focused = true; return this; }
  blur() { this._focused = false; return this; }
  select() { return this; }
  scrollIntoView() { return this; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollTo() { }
}

/* ============================================================
 * Document
 * ========================================================== */
function makeDocument() {
  const doc = new El('document');
  doc.nodeType = 9;
  doc.documentElement = new El('html');
  doc.head = new El('head');
  doc.body = new El('body');
  doc.readyState = 'complete';
  doc.title = '';
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => {
    const n = new El('#text');
    n.nodeType = 3;
    n.data = String(t);
    return n;
  };
  doc.createDocumentFragment = () => new El('#fragment');
  doc.getElementById = (id) => doc.querySelector('#' + id);
  return doc;
}

/**
 * 从真实 HTML 源码解析出 DOM 树（提取 body 内的元素与 id/class/属性）。
 * 只处理设置页/popup 所需的结构：标签、id、class、type、value、placeholder、a href。
 */
function parseHtml(html) {
  const doc = makeDocument();
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const src = bodyMatch ? bodyMatch[1] : html;

  // 先剥离 script/style 内容，避免被误解析为元素
  const cleaned = src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
  const tokenRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

  const stack = [doc.body];
  let last = null;
  let m;
  while ((m = tokenRe.exec(cleaned)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const closing = full[1] === '/';
    const selfClose = m[3] === '/';
    const attrStr = m[2] || '';

    if (closing) {
      // 回退到匹配的开标签
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }

    const node = new El(tag);
    const aRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = aRe.exec(attrStr)) !== null) {
      const key = am[1];
      const val = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : ''));
      node.setAttribute(key, val);
      if (key === 'value') node.value = val;
      if (key === 'type') node.type = val;
    }
    // checkbox 的 checked 属性
    if (/\bchecked\b/.test(attrStr)) node.checked = true;
    if (node.tagName === 'INPUT' && (node.type === 'checkbox' || node.type === 'radio')) {
      // 默认勾选状态由 HTML 决定，保持
    }

    stack[stack.length - 1].appendChild(node);
    last = node;

    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  void last;
  return doc;
}

/* ============================================================
 * Chrome API 模拟
 * ========================================================== */
function makeChrome(opts = {}) {
  const store = Object.assign({}, opts.storage || {});
  const listeners = { storage: [], message: [], tabsUpdated: [], tabsRemoved: [], installed: [] };
  const sent = [];       // 记录 sendMessage 目标
  const badge = {};      // tabId -> text
  const created = [];    // tabs.create 记录

  const tabs = opts.tabs || [];

  const chrome = {
    _store: store,
    _listeners: listeners,
    _sent: sent,
    _badge: badge,
    _created: created,

    storage: {
      local: {
        get(keys, cb) {
          if (typeof keys === 'string') return cb(keys in store ? { [keys]: store[keys] } : {});
          if (Array.isArray(keys)) {
            const out = {};
            keys.forEach((k) => { if (k in store) out[k] = store[k]; });
            return cb(out);
          }
          return cb(Object.assign({}, store));
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
          if (cb) cb();
        }
      },
      onChanged: {
        addListener(fn) { listeners.storage.push(fn); },
        _fire(changes, area) { listeners.storage.slice().forEach((f) => f(changes, area)); }
      }
    },

    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(msg);
        // 转发到已注册的 message 监听器（模拟 background）
        let responded = false;
        listeners.message.slice().forEach((fn) => {
          const r = fn(msg, { tab: { id: opts.tabId === undefined ? 1 : opts.tabId } }, (res) => {
            responded = true;
            if (cb) cb(res);
          });
          void r;
        });
        if (cb && !responded) cb(undefined);
      },
      onMessage: {
        addListener(fn) { listeners.message.push(fn); },
        _fire(msg, sender, cb) {
          listeners.message.slice().forEach((fn) => fn(msg, sender, cb));
        }
      },
      onInstalled: {
        addListener(fn) { listeners.installed.push(fn); }
      },
      getURL(p) { return 'chrome-extension://test/' + p; },
      openOptionsPage() { created.push({ type: 'options' }); }
    },

    tabs: {
      query(q, cb) {
        if (q && q.active) return cb(tabs.filter((t) => t.active));
        return cb(tabs);
      },
      sendMessage(tabId, msg, cb) {
        sent.push({ to: tabId, msg });
        if (cb) cb();
      },
      reload(id) { sent.push({ reload: id }); },
      create(o) { created.push(o); },
      onUpdated: { addListener(fn) { listeners.tabsUpdated.push(fn); } },
      onRemoved: { addListener(fn) { listeners.tabsRemoved.push(fn); } }
    },

    action: {
      setBadgeText({ tabId, text }) { badge[tabId] = text; },
      setBadgeBackgroundColor() {}
    }
  };

  return chrome;
}

/* ============================================================
 * 运行脚本
 * ========================================================== */
function makeSandbox(doc, chrome, location) {
  const sb = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Promise, JSON, Array, Object, String, Number, Boolean, Math, RegExp, Date, Error, Set, Map,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    Blob: class { constructor() {} },
    FileReader: class { readAsText() {} },
    confirm: () => true,
    alert: () => { },
    location: location || { protocol: 'https:', hostname: 'www.baidu.com', href: 'https://www.baidu.com/s' },
    document: doc,
    chrome
  };
  sb.globalThis = sb;
  sb.window = sb;
  sb.self = sb;
  return sb;
}

function createContext(sb) {
  vm.createContext(sb);
  return sb;
}

/** 载入公共模块（common + rules），返回 sandbox */
function loadCore(sb) {
  vm.runInContext(readSrc('shared/common.js'), sb, { filename: 'shared/common.js' });
  vm.runInContext(readSrc('rules/rules.js'), sb, { filename: 'rules/rules.js' });
  return sb;
}

/** 在已有 sandbox 中继续载入指定脚本 */
function loadFiles(sb, files) {
  files.forEach((f) => vm.runInContext(readSrc(f), sb, { filename: f }));
}

module.exports = {
  El, parseHtml, makeDocument, makeChrome, makeSandbox, createContext,
  loadCore, loadFiles, readSrc, matchOne, matchCompound
};