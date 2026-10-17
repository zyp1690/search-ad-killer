/**
 * 冒烟测试：验证多站点（百度 / 360 搜索）广告清理逻辑。
 * 运行：node test/smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ============================================================
 * 极简 DOM 模拟
 * ========================================================== */
class FakeElement {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this.textContent = attrs.__text || '';
    this.isConnected = true;
    this.classList = {
      contains: (c) => String(this.attributes.class || '').split(/\s+/).includes(c),
      add() {}, remove() {}
    };
    this.style = {
      props: {},
      setProperty(k, v, prio) { this.props[k] = prio ? v + '!' + prio : v; this._write(); },
      getPropertyValue(k) { return this.props[k] || ''; },
      removeProperty(k) { const v = this.props[k]; delete this.props[k]; this._write(); return v || ''; },
      set height(v) { this.setProperty('height', v); }, get height() { return this.props.height || ''; },
      set overflow(v) { this.setProperty('overflow', v); }, get overflow() { return this.props.overflow || ''; },
      set display(v) { this.setProperty('display', v); }, get display() { return this.props.display || ''; }
    };
    this.style._write = () => {
      this.attributes.style = Object.keys(this.style.props)
        .map((k) => `${k}: ${this.style.props[k]};`).join(' ');
    };
  }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
    if (k === 'style') this._syncStyle(String(v));
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k.startsWith('data-')) delete this.dataset[k.slice(5)];
    if (k === 'style') this.style.props = {};
  }
  hasAttribute(k) { return k in this.attributes; }
  _syncStyle(str) {
    this.style.props = {};
    String(str).split(';').forEach((d) => {
      const i = d.indexOf(':'); if (i === -1) return;
      const k = d.slice(0, i).trim();
      let v = d.slice(i + 1).trim();
      const imp = /!important$/i.test(v);
      if (imp) v = v.replace(/!important$/i, '').trim();
      this.style.props[k] = imp ? v + '!important' : v;
    });
  }
  appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; }
  insertBefore(n, ref) {
    n.parentElement = this;
    const i = this.childNodes.indexOf(ref);
    if (i === -1) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.childNodes.indexOf(this);
    if (i !== -1) this.parentElement.childNodes.splice(i, 1);
    this.parentElement = null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.childNodes, i = a.indexOf(this);
    return i > 0 ? a[i - 1] : null;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.childNodes, i = a.indexOf(this);
    return i !== -1 && i < a.length - 1 ? a[i + 1] : null;
  }
  matches(sel) { return sel.split(',').some((s) => matchCompound(this, s.trim())); }
  /**
   * 极简 innerHTML 支持：解析形如 <tag id="x" class="y">文本</tag> 的片段。
   * 仅用于让内容脚本创建的提示条结构在 mock 中可查询。
   */
  set innerHTML(html) {
    this.childNodes = [];
    this._html = String(html || '');
    const re = /<(\w+)([^>]*)>(.*?)<\/\1>/g;
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const [, tag, attrs, text] = m;
      const node = new FakeElement(tag);
      const aRe = /([\w-]+)="([^"]*)"/g;
      let am;
      while ((am = aRe.exec(attrs)) !== null) node.setAttribute(am[1], am[2]);
      node.textContent = text;
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  get innerHTML() { return this._html || ''; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.tagName) { if (c.matches(sel)) out.push(c); walk(c); }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener() {}
  removeEventListener() {}
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}

function matchOne(el, sel) {
  if (!sel) return false;
  const m = /^(.*?)((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const tokens = (m[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  for (const tk of tokens) {
    if (tk[0] === '#') { if (el.id !== tk.slice(1)) return false; }
    else if (tk[0] === '.') {
      if (!String(el.attributes.class || '').split(/\s+/).includes(tk.slice(1))) return false;
    } else {
      const am = /^\[([\w-]+)(?:=["']?([^"']*)["']?)?\]$/.exec(tk);
      if (!am) return false;
      const key = am[1];
      const fromData = key.startsWith('data-') && key.slice(5) in el.dataset;
      if (!(key in el.attributes) && !fromData) return false;
      if (am[2] !== undefined) {
        const actual = key in el.attributes ? el.attributes[key] : el.dataset[key.slice(5)];
        if (String(actual) !== am[2]) return false;
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
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node) {
      if (matchOne(node, parts[i])) { found = true; node = node.parentElement; break; }
      node = node.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

/* ============================================================
 * 断言工具
 * ========================================================== */
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? '  →  ' + extra : ''}`);
  }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ============================================================
 * 页面构建
 * ========================================================== */
function buildDoc() {
  const doc = new FakeElement('document');
  doc.documentElement = new FakeElement('html');
  doc.head = new FakeElement('head');
  doc.body = new FakeElement('body');
  doc.readyState = 'complete';
  doc.getElementById = (id) => doc.querySelector('#' + id);
  doc.createElement = (t) => new FakeElement(t);
  doc.addEventListener = () => {};
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

/** 构建百度搜索结果页 */
function buildBaiduPage(doc) {
  const cl = new FakeElement('div', { id: 'content_left' });
  const cr = new FakeElement('div', { id: 'content_right' });
  doc.body.appendChild(cl);
  doc.body.appendChild(cr);
  doc.body.appendChild(new FakeElement('div', { id: 'top-ad' }));

  const mk = (id, badgeClass) => {
    const card = new FakeElement('div', { class: 'c-container', id });
    if (badgeClass) card.appendChild(new FakeElement('span', { class: badgeClass, __text: '广告' }));
    cl.appendChild(card);
    return card;
  };
  mk('b1', 'ec-tuiguang');
  mk('b2', 'ecfc-tuiguang');
  mk('b3');                       // 正常结果
  const b4 = new FakeElement('div', { class: 'c-container', id: 'b4' });
  b4.appendChild(new FakeElement('span', { 'data-tuiguang': '1' }));
  cl.appendChild(b4);

  cr.appendChild(new FakeElement('div', { class: 'ec_ad_results' }));
  return { cl, cr };
}

/** 构建 360 搜索结果页 */
function buildSo360Page(doc) {
  const main = new FakeElement('div', { id: 'main' });
  doc.body.appendChild(main);

  // 品牌臻选广告
  main.appendChild(new FakeElement('div', { id: 'so_bd-ad' }));

  // 结果条目：正常 / 广告（.e-buss 角标）/ 商业推广文字广告
  const mk = (id, badgeClass) => {
    const li = new FakeElement('div', { class: 'res-list', id });
    if (badgeClass) li.appendChild(new FakeElement('span', { class: badgeClass, __text: '广告' }));
    main.appendChild(li);
    return li;
  };
  mk('s1');                                  // 正常结果
  mk('s2', 'e-buss');                         // 条目广告
  const s3 = new FakeElement('div', { class: 'res-list', id: 's3' });
  main.appendChild(s3);

  // 商业推广文字广告（div[id*="--normal"]）
  main.appendChild(new FakeElement('div', { id: 'ad--normal-123' }));

  // 底部遮罩广告
  main.appendChild(new FakeElement('div', { class: 'lawnfooter-image__panel' }));

  // 搜索框（受保护，不应被处理）
  const kw = new FakeElement('input', { id: 'kw' });
  doc.body.appendChild(kw);

  return { main };
}

/** 构建 搜狗搜索结果页 */
function buildSogouPage(doc) {
  const wrap = new FakeElement('div', { id: 'main' });
  doc.body.appendChild(wrap);
  const results = new FakeElement('div', { class: 'results', id: 'results' });
  wrap.appendChild(results);

  const mk = (id, adClass) => {
    const item = new FakeElement('div', { class: 'vrwrap', id });
    if (adClass) item.appendChild(new FakeElement('div', { class: adClass }));
    results.appendChild(item);
    return item;
  };
  mk('g1');                                  // 正常结果
  mk('g2', 'ad_result');                     // 推广条目
  results.appendChild(new FakeElement('div', { class: 'js-ad-item', id: 'g3' })); // 另一类广告
  wrap.appendChild(new FakeElement('div', { class: 'pop-tuiguang', id: 'g4' })); // 弹窗推广
  doc.body.appendChild(new FakeElement('input', { id: 'query' }));   // 搜索框
  return { results, wrap };
}

/** 构建 必应结果页 */
function buildBingPage(doc) {
  const content = new FakeElement('div', { id: 'b_content' });
  doc.body.appendChild(content);
  const results = new FakeElement('ol', { id: 'b_results' });
  content.appendChild(results);

  const mk = (id, cls) => {
    const li = new FakeElement('li', { class: cls, id });
    results.appendChild(li);
    return li;
  };
  mk('b1', 'b_algo');        // 正常结果
  mk('b2', 'b_algo b_ad');   // 赞助结果
  const b3 = new FakeElement('li', { class: 'b_ad', id: 'b3' });
  results.appendChild(b3);
  content.appendChild(new FakeElement('div', { class: 'pa_sb', id: 'b4' })); // 右栏广告
  doc.body.appendChild(new FakeElement('input', { id: 'sb_form_q' }));
  return { results, content };
}

/** 构建 Google 结果页 */
function buildGooglePage(doc) {
  const search = new FakeElement('div', { id: 'search' });
  doc.body.appendChild(search);
  const mk = (id, cls) => {
    const g = new FakeElement('div', { class: 'g ' + cls, id });
    search.appendChild(g);
    return g;
  };
  mk('g1', '');                    // 正常结果
  mk('g2', 'uEierd');              // 广告容器
  search.appendChild(new FakeElement('div', { id: 'tads' }));      // 顶部广告
  doc.body.appendChild(new FakeElement('textarea', { id: 'APjFqb' })); // 搜索框
  return { search };
}

/** 构建 DuckDuckGo 结果页 */
function buildDdgPage(doc) {
  const links = new FakeElement('div', { id: 'links' });
  doc.body.appendChild(links);
  const mk = (id, cls) => {
    const d = new FakeElement('div', { class: cls, id });
    links.appendChild(d);
    return d;
  };
  mk('d1', 'result');                 // 正常结果
  mk('d2', 'result result--ad');      // 广告结果
  doc.body.appendChild(new FakeElement('input', { id: 'search_form_input' }));
  return { links };
}

/* ============================================================
 * 运行内容脚本
 * ========================================================== */
function runContentScript(doc, siteHost, settingsObj) {
  const store = {};
  store.badcSettings = settingsObj;

  const chromeMock = {
    runtime: {
      sendMessage: (msg, cb) => { if (cb) cb({ ok: true }); },
      onMessage: { addListener: () => {} },
      lastError: null,
      getURL: (p) => p
    },
    storage: {
      local: {
        get: (k, cb) => cb(k in store ? { [k]: store[k] } : {}),
        set: (o, cb) => { Object.assign(store, o); if (cb) cb(); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: { query: (q, cb) => cb([]), sendMessage: () => {}, reload: () => {} }
  };

  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Promise, JSON, Array, Object, String, Number, Boolean, Math, RegExp, Date, Error, Set,
    MutationObserver: class { observe() {} disconnect() {} },
    location: { protocol: 'https:', hostname: siteHost, pathname: '/s', href: 'https://' + siteHost + '/s?q=test' },
    document: doc,
    chrome: chromeMock
  };
  sb.globalThis = sb;
  sb.window = sb;
  sb.__BADC_LOADED__ = false;

  vm.createContext(sb);
  ['shared/common.js', 'rules/rules.js', 'content/content.js'].forEach((f) => {
    vm.runInContext(readSrc(f), sb, { filename: f });
  });
  return sb;
}

function defaultSettings() {
  const sb0 = {};
  vm.createContext(Object.assign(sb0, {
    console, URL, Promise, JSON, Object, String, Boolean, Array,
    chrome: {
      storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener: () => {} } }
    }
  }));
  sb0.globalThis = sb0;
  vm.runInContext(readSrc('shared/common.js'), sb0);
  vm.runInContext(readSrc('rules/rules.js'), sb0);
  return sb0.BADC.buildDefaults();
}

function idsOf(container) {
  return container.childNodes.filter((n) => n.tagName).map((n) => n.id || n.attributes.id || '');
}

/* ============================================================
 * 1. 配置与注册表
 * ========================================================== */
section('配置与规则库');
const base = defaultSettings();
const sbRules = (() => {
  const s = { console, URL, Promise, JSON, Object, String, Boolean, Array, Math };
  s.globalThis = s;
  vm.createContext(s);
  vm.runInContext(readSrc('rules/rules.js'), s);
  return s.BADC_RULES;
})();

check('包含 6 个搜索站点', sbRules.siteKeys.length === 6, sbRules.siteKeys.join(','));
check('百度规则 12 条', sbRules.forSite('baidu').length === 12, String(sbRules.forSite('baidu').length));
check('360 规则 8 条', sbRules.forSite('so360').length === 8, String(sbRules.forSite('so360').length));
check('搜狗规则 7 条', sbRules.forSite('sogou').length === 7, String(sbRules.forSite('sogou').length));
check('必应规则 4 条', sbRules.forSite('bing').length === 4, String(sbRules.forSite('bing').length));
check('Google 规则 4 条', sbRules.forSite('google').length === 4, String(sbRules.forSite('google').length));
check('DDG 规则 2 条', sbRules.forSite('ddg').length === 2, String(sbRules.forSite('ddg').length));
check('配置含 6 个站点', Object.keys(base.sites).length === 6, Object.keys(base.sites).join(','));
check('360 站点配置含 brand 类型', !!(base.sites.so360.types.brand));
check('360 聚合页默认关闭', base.sites.so360.types.aggregated.enabled === false);
check('360 iframe 默认关闭', base.sites.so360.types.iframe.enabled === false);
check('搜狗/必应默认启用', base.sites.sogou.enabled === true && base.sites.bing.enabled === true);
check('Google 默认关闭（误判风险）', base.sites.google.enabled === false);
check('DuckDuckGo 默认关闭', base.sites.ddg.enabled === false);
check('未知站点返回空规则集', sbRules.forSite('nope').length === 0);
check('每站点都定义了主容器', Object.keys(sbRules.SITES).every((k) => sbRules.SITES[k].mainContainers.length > 0));

/* ============================================================
 * 2. 站点识别
 * ========================================================== */
section('站点识别');
const sbCommon = (() => {
  const s = {
    console, URL, Promise, JSON, Object, String, Boolean, Array,
    chrome: { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener: () => {} } } }
  };
  s.globalThis = s;
  vm.createContext(s);
  vm.runInContext(readSrc('shared/common.js'), s);
  vm.runInContext(readSrc('rules/rules.js'), s);
  return s.BADC;
})();

check('www.baidu.com → baidu', sbCommon.siteOfHost('www.baidu.com') === 'baidu');
check('m.baidu.com → baidu', sbCommon.siteOfHost('m.baidu.com') === 'baidu');
check('www.so.com → so360', sbCommon.siteOfHost('www.so.com') === 'so360');
check('m.so.com → so360', sbCommon.siteOfHost('m.so.com') === 'so360');
check('so.com → so360', sbCommon.siteOfHost('so.com') === 'so360');
check('www.sogou.com → sogou', sbCommon.siteOfHost('www.sogou.com') === 'sogou');
check('m.sogou.com → sogou', sbCommon.siteOfHost('m.sogou.com') === 'sogou');
check('www.bing.com → bing', sbCommon.siteOfHost('www.bing.com') === 'bing');
check('cn.bing.com → bing', sbCommon.siteOfHost('cn.bing.com') === 'bing');
check('www.google.com → google', sbCommon.siteOfHost('www.google.com') === 'google');
check('duckduckgo.com → ddg', sbCommon.siteOfHost('duckduckgo.com') === 'ddg');
check('lite.duckduckgo.com → ddg', sbCommon.siteOfHost('lite.duckduckgo.com') === 'ddg');
check('tieba.baidu.com 被排除', sbCommon.siteOfHost('tieba.baidu.com') === null);
check('image.so.com 被排除', sbCommon.siteOfHost('image.so.com') === null);
check('news.so.com 被排除', sbCommon.siteOfHost('news.so.com') === null);
check('pic.sogou.com 被排除', sbCommon.siteOfHost('pic.sogou.com') === null);
check('images.bing.com 被排除', sbCommon.siteOfHost('images.bing.com') === null);
check('images.google.com 被排除', sbCommon.siteOfHost('images.google.com') === null);
check('maps.duckduckgo.com 被排除', sbCommon.siteOfHost('maps.duckduckgo.com') === null);
check('example.com 不匹配', sbCommon.siteOfHost('example.com') === null);

/* ============================================================
 * 3. v1 配置迁移
 * ========================================================== */
section('旧配置迁移');
const migrated = sbCommon.normalize({
  enabled: true, mode: 'hide',
  types: { inline: { enabled: false }, sidebar: { enabled: true, wholeBlock: true } },
  customSelectors: '.legacy-ad'
});
check('旧 config.mode 被保留', migrated.mode === 'hide');
check('旧 types 迁入 baidu 站点', migrated.sites.baidu.types.inline.enabled === false);
check('旧 wholeBlock 被保留', migrated.sites.baidu.types.sidebar.wholeBlock === true);
check('360 站点用默认值初始化', migrated.sites.so360.types.brand.enabled === true);

// v2 的 per-site customSelectors 字符串应迁移为 v3 跨平台规则
const migrated2 = sbCommon.normalize({
  sites: {
    baidu: { customSelectors: '.ad-a\n#main .ad-b\n// 注释行\n/* 块注释 */' },
    sogou: { customSelectors: '.sg-ad' }
  }
});
check('v2 字符串迁移为 customRules 数组', Array.isArray(migrated2.customRules));
check('迁移后规则总数正确（忽略 2 行注释）', migrated2.customRules.length === 3,
  String(migrated2.customRules.length));
check('# 开头的 ID 选择器未被误当注释丢弃',
  migrated2.customRules.some((r) => r.selector === '#main .ad-b'),
  JSON.stringify(migrated2.customRules.map((r) => r.selector)));
check('// 注释行被忽略', !migrated2.customRules.some((r) => r.selector === '// 注释行'));
check('/* 块注释被忽略', !migrated2.customRules.some((r) => r.selector === '/* 块注释 */'));
check('原平台归属被保留',
  migrated2.customRules.filter((r) => r.sites.length === 1 && r.sites[0] === 'baidu').length === 2);
check('搜狗规则迁入 sogou 平台',
  migrated2.customRules.some((r) => r.selector === '.sg-ad' && r.sites[0] === 'sogou'));

// 跨平台规则：未指定 sites 时默认全平台
const migrated3 = sbCommon.normalize({
  customRules: [{ selector: '#ads' }, { selector: '.x', sites: ['bing', 'nosuch'] }]
});
check('未指定平台的规则默认全平台生效', migrated3.customRules[0].sites.length === 6,
  String(migrated3.customRules[0].sites.length));
check('非法平台 key 被剔除', migrated3.customRules[1].sites.length === 1 &&
  migrated3.customRules[1].sites[0] === 'bing');

// 按平台筛选
const allKeys = sbCommon.SITE_DEFS.map((d) => d.key);
check('selectorsForSite 正确筛选多平台规则',
  sbCommon.selectorsForSite(migrated3, 'bing').join(',') === '#ads,.x',
  sbCommon.selectorsForSite(migrated3, 'bing').join(','));
check('selectorsForSite 对无关平台返回空',
  sbCommon.selectorsForSite({ customRules: [{ selector: '.a', sites: ['baidu'] }] }, 'google').length === 0);
check('splitSelectorLines 保留 # 开头选择器',
  sbCommon.splitSelectorLines('#x\n.y\n//z').join('|') === '#x|.y',
  sbCommon.splitSelectorLines('#x\n.y\n//z').join('|'));

/* ============================================================
 * 4. 百度清理（remove 模式）
 * ========================================================== */
section('百度清理 · remove 模式');
const docB = buildDoc();
const { cl: clB, cr: crB } = buildBaiduPage(docB);
const cfgB = defaultSettings();
cfgB.mode = 'remove';
runContentScript(docB, 'www.baidu.com', cfgB);

setTimeout(() => {
  const left = idsOf(clB);
  check('推广条目 b1/b2/b4 已删除',
    !left.includes('b1') && !left.includes('b2') && !left.includes('b4'), left.join(','));
  check('正常结果 b3 保留', left.includes('b3'), left.join(','));
  check('#content_left 未被删除', !!docB.querySelector('#content_left'));
  check('右侧推广已删除', crB.childNodes.filter((n) => n.tagName).length === 0);
  check('顶部广告已删除', docB.querySelectorAll('#top-ad').length === 0);

  // 串行执行后续场景测试
  runNext([
    testSo360Remove,
    testSo360Hide,
    testSiteIsolation,
    testProtected,
    testConfigToggle,
    testSogou,
    testBing,
    testGoogle,
    testDdg,
    testCrossSiteIsolation,
    testCustomRulesCrossSite,
    testMultiSelectAggregation
  ]);
}, 80);

/** 串行执行测试队列，全部结束后汇总 */
function runNext(queue) {
  let i = 0;
  (function next() {
    if (i >= queue.length) {
      console.log('\n' + '='.repeat(46));
      console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
      console.log('='.repeat(46));
      process.exit(fail > 0 ? 1 : 0);
      return;
    }
    const task = queue[i++];
    task(function () { setTimeout(next, 20); });
  })();
}

/* ============================================================
 * 5. 360 清理（remove 模式）
 * ========================================================== */
function testSo360Remove(done) {
  section('360 清理 · remove 模式');
  const doc = buildDoc();
  const { main } = buildSo360Page(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.so.com', cfg);

  setTimeout(() => {
    const left = idsOf(main);
    check('品牌广告 #so_bd-ad 已删除', doc.querySelectorAll('#so_bd-ad').length === 0);
    check('条目广告（.e-buss 角标）已删除', !left.includes('s2'), left.join(','));
    check('正常结果 s1 保留', left.includes('s1'), left.join(','));
    check('正常结果 s3 保留', left.includes('s3'), left.join(','));
    check('商业推广文字广告已删除', doc.querySelectorAll('[id*="--normal"]').length === 0);
    check('底部遮罩广告已删除', doc.querySelectorAll('.lawnfooter-image__panel').length === 0);
    check('360 主容器 #main 未被删除', !!doc.querySelector('#main'));
    done();
  }, 80);
}

/* ============================================================
 * 6. 360 清理（hide 模式）+ 安全校验
 * ========================================================== */
function testSo360Hide(done) {
  section('360 清理 · hide 模式与安全校验');
  const doc = buildDoc();
  const { main } = buildSo360Page(doc);
  const cfg = defaultSettings();
  cfg.mode = 'hide';
  runContentScript(doc, 'www.so.com', cfg);

  setTimeout(() => {
    const adCard = main.childNodes.find((n) => n.id === 's2');
    const normalCard = main.childNodes.find((n) => n.id === 's1');
    check('hide 模式隐藏了整张广告卡片',
      adCard && adCard.style.getPropertyValue('display') === 'none!important',
      adCard ? adCard.style.getPropertyValue('display') : '(未找到)');
    check('正常结果未被隐藏',
      normalCard && !normalCard.style.getPropertyValue('display'),
      normalCard ? normalCard.style.getPropertyValue('display') : '(未找到)');

    // 还原校验
    if (adCard) {
      const prev = adCard.dataset.badcPrevStyle;
      if (prev) adCard.setAttribute('style', prev); else adCard.removeAttribute('style');
      adCard.removeAttribute('data-badc');
      check('展开后 display 复位', !adCard.style.getPropertyValue('display'));
    }
    done();
  }, 80);
}

/* ============================================================
 * 7. 站点隔离：360 页面不应受百度规则影响
 * ========================================================== */
function testSiteIsolation(done) {
  section('站点隔离');
  const doc = buildDoc();
  const { main } = buildSo360Page(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.so.com', cfg);

  setTimeout(() => {
    // 构造一个百度广告结构，若站点隔离失效会被误删
    const baiduLike = new FakeElement('div', { class: 'ec_ad_results', id: 'xbaidu' });
    main.appendChild(baiduLike);
    const card = new FakeElement('div', { class: 'c-container', id: 'xcard' });
    card.appendChild(new FakeElement('span', { class: 'ec-tuiguang' }));
    main.appendChild(card);

    setTimeout(() => {
      check('360 页面不套用百度规则（.ec_ad_results 保留）',
        doc.querySelectorAll('.ec_ad_results').length === 1);
      check('360 页面不套用百度规则（.ec-tuiguang 角标保留）',
        doc.querySelectorAll('.ec-tuiguang').length === 1);
      done();
    }, 60);
  }, 80);
}

/* ============================================================
 * 8. 受保护节点
 * ========================================================== */
function testProtected(done) {
  section('受保护节点');
  const doc = buildDoc();
  buildSo360Page(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  // 自定义一条会命中搜索框与主容器的规则
  cfg.customRules = [{ selector: 'input, #main', sites: ['so360'] }];
  runContentScript(doc, 'www.so.com', cfg);

  setTimeout(() => {
    check('搜索框未被删除', !!doc.querySelector('#kw'));
    check('主容器未被自定义规则删除', !!doc.querySelector('#main'));
    check('body 未被删除', !!doc.body);
    done();
  }, 80);
}

/* ============================================================
 * 9. 站点总开关
 * ========================================================== */
function testConfigToggle(done) {
  section('站点总开关');
  const doc = buildDoc();
  const { main } = buildSo360Page(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  cfg.sites.so360.enabled = false;   // 关闭 360 净化
  runContentScript(doc, 'www.so.com', cfg);

  setTimeout(() => {
    check('关闭 360 净化后不再处理广告', doc.querySelectorAll('#so_bd-ad').length === 1);
    check('关闭后正常结果不受影响', idsOf(main).includes('s1'));
    done();
  }, 80);
}

/* ============================================================
 * 10. 搜狗搜索
 * ========================================================== */
function testSogou(done) {
  section('搜狗搜索清理');
  const doc = buildDoc();
  const { results } = buildSogouPage(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.sogou.com', cfg);

  setTimeout(() => {
    const left = idsOf(results);
    check('搜狗推广条目 .ad_result 已删除', !left.includes('g2'), left.join(','));
    check('搜狗 .js-ad-item 已删除', !left.includes('g3'), left.join(','));
    check('搜狗弹窗推广已删除', doc.querySelectorAll('.pop-tuiguang').length === 0);
    check('搜狗正常结果保留', left.includes('g1'), left.join(','));
    check('搜狗搜索框未被删除', !!doc.querySelector('#query'));
    done();
  }, 80);
}

/* ============================================================
 * 11. 必应
 * ========================================================== */
function testBing(done) {
  section('必应清理');
  const doc = buildDoc();
  const { results } = buildBingPage(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.bing.com', cfg);

  setTimeout(() => {
    const left = idsOf(results);
    check('必应赞助条目 .b_ad 已删除', !left.includes('b2') && !left.includes('b3'), left.join(','));
    check('必应右栏广告 .pa_sb 已删除', doc.querySelectorAll('.pa_sb').length === 0);
    check('必应正常结果 b1 保留', left.includes('b1'), left.join(','));
    check('必应搜索框未被删除', !!doc.querySelector('#sb_form_q'));
    done();
  }, 80);
}

/* ============================================================
 * 12. Google（需手动开启）
 * ========================================================== */
function testGoogle(done) {
  section('Google 清理（默认关闭）');
  const doc = buildDoc();
  buildGooglePage(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.google.com', cfg);   // 默认 enabled=false

  setTimeout(() => {
    check('Google 默认关闭时不处理任何元素', doc.querySelectorAll('.uEierd').length === 1,
      String(doc.querySelectorAll('.uEierd').length));
    check('Google 默认关闭时顶部广告条保留', doc.querySelectorAll('#tads').length === 1);

    // 开启后应正常清理
    const doc2 = buildDoc();
    buildGooglePage(doc2);
    const cfg2 = defaultSettings();
    cfg2.mode = 'remove';
    cfg2.sites.google.enabled = true;
    runContentScript(doc2, 'www.google.com', cfg2);

    setTimeout(() => {
      check('开启后 Google 广告容器已删除', doc2.querySelectorAll('.uEierd').length === 0);
      check('开启后顶部广告条已删除', doc2.querySelectorAll('#tads').length === 0);
      check('开启后正常结果保留', idsOf(doc2.querySelector('#search')).includes('g1'));
      done();
    }, 80);
  }, 80);
}

/* ============================================================
 * 13. DuckDuckGo（需手动开启）
 * ========================================================== */
function testDdg(done) {
  section('DuckDuckGo 清理（默认关闭）');
  const doc = buildDoc();
  buildDdgPage(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  cfg.sites.ddg.enabled = true;      // 手动开启
  runContentScript(doc, 'duckduckgo.com', cfg);

  setTimeout(() => {
    const left = idsOf(doc.querySelector('#links'));
    check('DDG 广告结果 .result--ad 已删除', !left.includes('d2'), left.join(','));
    check('DDG 正常结果保留', left.includes('d1'), left.join(','));
    check('DDG 搜索框未被删除', !!doc.querySelector('#search_form_input'));
    done();
  }, 80);
}

/* ============================================================
 * 14. 跨站点隔离：必应页面不应受百度规则影响
 * ========================================================== */
function testCrossSiteIsolation(done) {
  section('跨站点隔离');
  const doc = buildDoc();
  const { results } = buildBingPage(doc);
  const cfg = defaultSettings();
  cfg.mode = 'remove';
  runContentScript(doc, 'www.bing.com', cfg);

  setTimeout(() => {
    // 在必应页面塞入百度/搜狗的广告结构
    results.appendChild(new FakeElement('div', { class: 'ec_ad_results', id: 'xbaidu' }));
    results.appendChild(new FakeElement('div', { class: 'ad_result', id: 'xsogou' }));
    const card = new FakeElement('div', { class: 'uEierd', id: 'xgoogle' });
    results.appendChild(card);

    setTimeout(() => {
      check('必应页面不套用百度规则', doc.querySelectorAll('.ec_ad_results').length === 1);
      check('必应页面不套用搜狗规则', doc.querySelectorAll('.ad_result').length === 1);
      check('必应页面不套用 Google 规则', doc.querySelectorAll('.uEierd').length === 1);
      done();
    }, 60);
  }, 80);
}

/* ============================================================
 * 15. 跨平台自定义规则
 * ========================================================== */
function testCustomRulesCrossSite(done) {
  section('跨平台自定义规则');

  // 同一条规则同时作用于百度与必应
  const rules = [
    { selector: '.shared-ad', sites: ['baidu', 'bing'] },
    { selector: '#only-baidu', sites: ['baidu'] },
    { selector: '#only-bing', sites: ['bing'] }
  ];

  // --- 百度页面 ---
  const docB = buildDoc();
  const { cl } = buildBaiduPage(docB);
  cl.appendChild(new FakeElement('div', { class: 'shared-ad', id: 'ca1' }));
  docB.body.appendChild(new FakeElement('div', { id: 'only-baidu' }));
  docB.body.appendChild(new FakeElement('div', { id: 'only-bing' }));  // 不该被删
  const cfgB = defaultSettings();
  cfgB.mode = 'remove';
  cfgB.customRules = JSON.parse(JSON.stringify(rules));
  runContentScript(docB, 'www.baidu.com', cfgB);

  setTimeout(() => {
    check('百度：多平台规则已生效', docB.querySelectorAll('.shared-ad').length === 0);
    check('百度：专属规则已生效', docB.querySelectorAll('#only-baidu').length === 0);
    check('百度：必应专属规则未误删', docB.querySelectorAll('#only-bing').length === 1);

    // --- 必应页面 ---
    const docY = buildDoc();
    const { results } = buildBingPage(docY);
    results.appendChild(new FakeElement('div', { class: 'shared-ad', id: 'ca2' }));
    docY.body.appendChild(new FakeElement('div', { id: 'only-bing' }));
    docY.body.appendChild(new FakeElement('div', { id: 'only-baidu' }));  // 不该被删
    const cfgY = defaultSettings();
    cfgY.mode = 'remove';
    cfgY.customRules = JSON.parse(JSON.stringify(rules));
    runContentScript(docY, 'www.bing.com', cfgY);

    setTimeout(() => {
      check('必应：同一条多平台规则同样生效', docY.querySelectorAll('.shared-ad').length === 0);
      check('必应：专属规则已生效', docY.querySelectorAll('#only-bing').length === 0);
      check('必应：百度专属规则未误删', docY.querySelectorAll('#only-baidu').length === 1);

      // --- # 开头的 ID 选择器实际生效 ---
      const docH = buildDoc();
      const { cl: clH } = buildBaiduPage(docH);
      docH.body.appendChild(new FakeElement('div', { id: 'hash-sel' }));
      const cfgH = defaultSettings();
      cfgH.mode = 'remove';
      cfgH.customRules = [{ selector: '#hash-sel', sites: ['baidu'] }];
      runContentScript(docH, 'www.baidu.com', cfgH);

      setTimeout(() => {
        check('# 开头的 ID 选择器实际生效（曾被误当注释丢弃）',
          docH.querySelectorAll('#hash-sel').length === 0,
          String(docH.querySelectorAll('#hash-sel').length));
        done();
      }, 80);
    }, 80);
  }, 80);
}

/* ============================================================
 * 16. 多平台批量配置的聚合逻辑
 * ========================================================== */
function testMultiSelectAggregation(done) {
  section('多平台批量配置聚合逻辑');
  const cfg = defaultSettings();

  // 构造混合状态：百度开 inline、360 关 inline；二者都有 inline 类型
  cfg.sites.baidu.types.inline.enabled = true;
  cfg.sites.so360.types.inline.enabled = false;
  // 独有类型：baidu 有 baitiao，ddg 没有
  cfg.sites.baidu.types.baitiao.enabled = true;

  const selected = ['baidu', 'so360'];
  const allKeys = sbCommon.SITE_DEFS.map((d) => d.key);

  /** 复刻 options.js renderRules 的并集与三态计算，用于验证语义 */
  function aggregate(selectedKeys) {
    const union = {};
    const order = [];
    selectedKeys.forEach((k) => {
      sbRules.forSite(k).forEach((r) => {
        if (!union[r.id]) { union[r.id] = { rule: r, holders: [] }; order.push(r.id); }
        union[r.id].holders.push(k);
      });
    });
    return order.map((id) => {
      const holders = union[id].holders;
      const on = holders.filter((k) => {
        const t = cfg.sites[k].types[id];
        return t && t.enabled;
      }).length;
      return {
        id,
        holders: holders.length,
        state: on === holders.length ? 'on' : (on === 0 ? 'off' : 'mixed')
      };
    });
  }

  const agg = aggregate(selected);
  const inline = agg.find((x) => x.id === 'inline');
  check('inline 存在于两个平台', inline.holders === 2, String(inline.holders));
  check('inline 部分开启 → 三态为 mixed', inline.state === 'mixed', inline.state);

  const baitiao = agg.find((x) => x.id === 'baitiao');
  check('baitiao 仅存在于百度', baitiao.holders === 1, String(baitiao.holders));
  check('baitiao 全开 → 三态为 on', baitiao.state === 'on', baitiao.state);

  // brand 是 360 独有类型：选中 so360 时应出现在并集，且只算 1 个持有平台
  check('brand（360 独有）出现在并集', agg.some((x) => x.id === 'brand'));
  check('brand 仅算 1 个持有平台', agg.find((x) => x.id === 'brand').holders === 1,
    String(agg.find((x) => x.id === 'brand').holders));

  // 只选百度时，360 独有的 brand 不应出现
  check('仅选百度时 360 独有类型不出现',
    !aggregate(['baidu']).some((x) => x.id === 'brand'));

  // 勾选语义：把 mixed 的 inline 勾上 → 两个平台都开
  selected.forEach((k) => {
    const t = cfg.sites[k].types.inline;
    if (t) t.enabled = true;
  });
  check('勾选后百度 inline 开启', cfg.sites.baidu.types.inline.enabled === true);
  check('勾选后 360 inline 开启', cfg.sites.so360.types.inline.enabled === true);
  check('勾选后三态变为 on', aggregate(selected).find((x) => x.id === 'inline').state === 'on');

  // 取消勾选 → 两个平台都关
  selected.forEach((k) => {
    const t = cfg.sites[k].types.inline;
    if (t) t.enabled = false;
  });
  check('取消后三态变为 off', aggregate(selected).find((x) => x.id === 'inline').state === 'off');

  // selectSafe 语义：只启用 risk==='safe' 的类型
  ['baidu', 'so360', 'sogou', 'bing'].forEach((k) => {
    sbRules.forSite(k).forEach((r) => {
      cfg.sites[k].types[r.id].enabled = r.risk === 'safe';
    });
  });
  const riskyOn = ['baidu', 'so360', 'sogou', 'bing'].some((k) =>
    sbRules.forSite(k).some((r) => r.risk !== 'safe' && cfg.sites[k].types[r.id].enabled));
  check('selectSafe 后无非安全项被启用', !riskyOn);

  // 全选语义
  ['baidu', 'so360', 'sogou', 'bing'].forEach((k) => {
    sbRules.forSite(k).forEach((r) => { cfg.sites[k].types[r.id].enabled = true; });
  });
  const allOn = ['baidu', 'so360', 'sogou', 'bing'].every((k) =>
    sbRules.forSite(k).every((r) => cfg.sites[k].types[r.id].enabled));
  check('全选后所有平台所有类型均开启', allOn);

  // 未选择平台时聚合为空
  check('未选择平台时并集为空', aggregate([]).length === 0);
  check('全部平台数一致', allKeys.length === 6);
  done();
}

/* ============================================================
 * 17. 静态平台卡片与配置一致性
 * 平台卡片已硬编码在 options.html 中，需保证与 SITE_DEFS / 默认配置一致。
 * ========================================================== */
section('静态平台卡片一致性');
(function () {
  const html = readSrc('options/options.html');
  const grid = html.slice(html.indexOf('id="platformGrid"'),
    html.indexOf('id="siteConfig"'));
  const cards = {};
  const re = /data-site="(\w+)"([\s\S]*?)(?=data-site=|$)/g;
  let m;
  while ((m = re.exec(grid)) !== null) {
    const key = m[1];
    const body = m[2];
    const chk = /<input type="checkbox"[^>]*checked/.test(body);
    const swm = body.match(/platform__switch" data-on="(\d)"/);
    const urlm = body.match(/platform__url"[^>]*>([^<]+)</);
    cards[key] = {
      checked: chk,
      on: swm ? swm[1] === '1' : null,
      url: urlm ? urlm[1] : ''
    };
  }
  const defKeys = sbCommon.SITE_DEFS.map((d) => d.key);

  check('静态卡片数量为 6', Object.keys(cards).length === 6,
    String(Object.keys(cards).length));
  check('无缺失平台卡片', defKeys.every((k) => !!cards[k]),
    defKeys.filter((k) => !cards[k]).join(','));
  check('无多余平台卡片', Object.keys(cards).every((k) => defKeys.includes(k)));

  // 默认启用状态须与 buildDefaults 一致
  const base2 = defaultSettings();
  check('开关初值与默认配置一致',
    defKeys.every((k) => cards[k].on === base2.sites[k].enabled),
    defKeys.filter((k) => cards[k].on !== base2.sites[k].enabled).join(','));

  // 默认仅百度被勾选加入配置
  const checkedKeys = defKeys.filter((k) => cards[k].checked);
  check('默认仅 baidu 加入配置', checkedKeys.length === 1 && checkedKeys[0] === 'baidu',
    checkedKeys.join(','));

  // 域名须与 SITE_DEFS 首条 hosts 一致
  const urlMismatch = defKeys.filter((k) => cards[k].url !== siteUrlOf(k));
  check('卡片域名与 SITE_DEFS 一致', urlMismatch.length === 0, urlMismatch.join(','));

  function siteUrlOf(key) {
    const d = sbCommon.SITE_DEFS.filter((x) => x.key === key)[0];
    return d.hosts[0];
  }
})();

function summary() {
  console.log('\n' + '='.repeat(46));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(46));
  process.exit(fail > 0 ? 1 : 0);
}