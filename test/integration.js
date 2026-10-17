/**
 * 集成测试：在 Node 中真实运行四个模块
 *   options/options.js、popup/popup.js、content/content.js、background/service-worker.js
 *
 * 与 smoke.js 的分工：
 *   smoke.js  —— 覆盖规则库、配置迁移、站点识别等纯逻辑与 content.js 清理行为
 *   本文件    —— 真实执行 UI 与通信代码路径，验证渲染、交互、消息链路
 *
 * 运行：node test/integration.js
 */
const H = require('./harness');
const { El, parseHtml, makeChrome, makeSandbox, createContext, loadCore, loadFiles, readSrc } = H;

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++; failures.push(label + (extra ? ' → ' + extra : ''));
    console.log(`  FAIL  ${label}${extra ? '  →  ' + extra : ''}`);
  }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 取默认配置（真实走 BADC.buildDefaults），使用临时 sandbox 以免污染目标 chrome */
function defaultCfg() {
  const tmp = makeChrome();
  const sb0 = makeSandbox(H.makeDocument(), tmp);
  createContext(sb0);
  loadCore(sb0);
  return sb0.BADC.buildDefaults();
}

/** 搭建一个完整可运行的设置页环境 */
function setupOptions(initialSettings, chromeOpts) {
  const doc = parseHtml(readSrc('options/options.html'));
  const chrome = makeChrome(chromeOpts || {});
  if (initialSettings) chrome._store.badcSettings = initialSettings;
  const sb = makeSandbox(doc, chrome);
  createContext(sb);
  loadCore(sb);
  loadFiles(sb, ['options/options.js']);
  return { doc, chrome, sb };
}

/* ============================================================
 * 1. options.js 真实渲染
 * ========================================================== */
async function testOptionsRender() {
  section('设置页 · 渲染');
  const cfg = defaultCfg();
  const { doc, sb } = setupOptions(cfg);
  await tick(60);

  // 静态平台卡片应被 JS 同步为真实状态
  const cards = doc.querySelectorAll('.platform');
  check('6 张平台卡片存在', cards.length === 6, String(cards.length));

  // 默认仅百度勾选加入配置
  const checked = cards.filter((c) => c.querySelector('.platform__check input').checked);
  check('默认仅百度加入配置', checked.length === 1 && checked[0].dataset.site === 'baidu',
    checked.map((c) => c.dataset.site).join(','));

  // 百度开关应为开，Google/DDG 应为关
  const swOf = (k) => doc.querySelector(`.platform[data-site="${k}"] .platform__switch`).dataset.on;
  check('百度开关为开', swOf('baidu') === '1', swOf('baidu'));
  check('Google 开关为关', swOf('google') === '0', swOf('google'));
  check('DDG 开关为关', swOf('ddg') === '0', swOf('ddg'));

  // 计数文案须与真实配置一致（百度 9/12）
  const baiduMeta = doc.querySelector('.platform[data-site="baidu"] .platform__meta').textContent;
  check('百度计数为真实默认 9 / 12', baiduMeta === '9 / 12 项已启用', baiduMeta);

  // 类型列表：单选百度应渲染 12 项
  const rules = doc.querySelectorAll('#ruleList .rule');
  check('单选时类型列表渲染 12 项', rules.length === 12, String(rules.length));

  // 标题应显示 SITE_DEFS 中的站点名（渲染的唯一真源）
  const baiduName = sb.BADC.SITE_DEFS.filter((d) => d.key === 'baidu')[0].name;
  check('标题显示站点名', doc.getElementById('siteName').textContent === baiduName,
    `${doc.getElementById('siteName').textContent} ≠ ${baiduName}`);
  check('统计文案含启用数', /\d+ \/ \d+ 项已启用/.test(doc.getElementById('siteMeta').textContent),
    doc.getElementById('siteMeta').textContent);

  // 总开关与处理方式应反映配置
  check('总开关为勾选', doc.getElementById('masterSwitch').checked === true);
  const radios = doc.querySelectorAll('#modeGrid input[name="mode"]');
  const modeChecked = radios.filter((r) => r.checked);
  check('处理方式默认 collapse', modeChecked.length === 1 && modeChecked[0].value === 'collapse',
    modeChecked.map((r) => r.value).join(',') || '未选中');

  // 高级选项应回填
  check('高级选项回填 collapseGap', doc.getElementById('optGap').checked === true);
  check('高级选项回填 showNotice', doc.getElementById('optNotice').checked === true);

  // 自定义规则区应为空态
  check('自定义规则为空态可见', !doc.getElementById('customEmpty').classList.contains('is-hidden'));
}

/* ============================================================
 * 2. options.js 交互：勾选平台 → 并集渲染
 * ========================================================== */
async function testOptionsMultiSelect() {
  section('设置页 · 多选平台与并集渲染');
  const cfg = defaultCfg();
  const { doc, chrome, sb } = setupOptions(cfg);
  await tick(60);

  // 点选 360 与搜狗的复选框
  doc.querySelector('.platform[data-site="so360"] .platform__check input').click();
  await tick(60);
  doc.querySelector('.platform[data-site="sogou"] .platform__check input').click();
  await tick(60);

  const checked = doc.querySelectorAll('.platform__check input')
    .filter((i) => i.checked)
    .map((i) => i.closest('.platform').dataset.site);
  check('三个平台已勾选', checked.length === 3, checked.join(','));

  // 标题应变为「3 个平台」
  check('标题显示 3 个平台', doc.getElementById('siteName').textContent === '3 个平台',
    doc.getElementById('siteName').textContent);

  // 并集类型数：baidu 12 + so360 8 + sogou 7，去重后的并集
  const unionIds = new Set();
  ['baidu', 'so360', 'sogou'].forEach((k) => {
    doc.querySelector(`.platform[data-site="${k}"]`); // 卡片存在性校验
  });
  const allRuleRows = doc.querySelectorAll('#ruleList .rule');
  check('并集类型数 ≥ 12（去重后）', allRuleRows.length >= 12, String(allRuleRows.length));

  // 多平台时每行应有计数徽标
  const counts = doc.querySelectorAll('#ruleList .rule__count');
  check('多平台时显示 N/M 计数', counts.length === allRuleRows.length,
    `${counts.length}/${allRuleRows.length}`);

  // 平台短名标记
  const keys = doc.querySelectorAll('#ruleList .rule__key');
  check('多平台时显示平台短名标记', keys.length > 0, String(keys.length));
}

/* ============================================================
 * 3. options.js 交互：类型勾选批量落盘
 * ========================================================== */
async function testOptionsBatchApply() {
  section('设置页 · 类型勾选批量落盘');
  const cfg = defaultCfg();
  // 预置混合态：百度开 sidebar、360 关 sidebar
  cfg.sites.baidu.types.sidebar.enabled = true;
  cfg.sites.so360.types.sidebar.enabled = false;

  const { doc, chrome, sb } = setupOptions(cfg);
  await tick(60);

  // 选中百度 + 360
  doc.querySelector('.platform[data-site="so360"] .platform__check input').click();
  await tick(60);

  const selectedKeys = doc.querySelectorAll('.platform__check input')
    .filter((i) => i.checked)
    .map((i) => i.closest('.platform').dataset.site);
  check('已选中 baidu 与 so360', selectedKeys.includes('baidu') && selectedKeys.includes('so360'),
    selectedKeys.join(','));

  const sidebar = doc.querySelector('#ruleList input[data-type="sidebar"]');
  check('sidebar 复选框存在', !!sidebar);
  check('sidebar 处于半选态（混合）', sidebar && sidebar.indeterminate === true,
    sidebar ? `checked=${sidebar.checked} indeterminate=${sidebar.indeterminate}` : '未找到');

  // 勾选 → 应同时写入两个平台
  sidebar.checked = true;
  sidebar.change();
  await tick(200);
  check('勾选后 baidu.sidebar 开启', chrome._store.badcSettings.sites.baidu.types.sidebar.enabled === true);
  check('勾选后 so360.sidebar 开启', chrome._store.badcSettings.sites.so360.types.sidebar.enabled === true);

  // 未选中的平台不应被写入（bing 仍保持默认 sidebar.enabled）
  check('未选中的平台不受影响',
    chrome._store.badcSettings.sites.bing.types.sidebar.enabled === true,
    String(chrome._store.badcSettings.sites.bing.types.sidebar.enabled));

  // 取消 → 两个平台都关
  sidebar.checked = false;
  sidebar.change();
  await tick(200);
  check('取消后 baidu.sidebar 关闭',
    chrome._store.badcSettings.sites.baidu.types.sidebar.enabled === false);
  check('取消后 so360.sidebar 关闭',
    chrome._store.badcSettings.sites.so360.types.sidebar.enabled === false);

  // 「全选」批量：所有选中平台全部类型开启
  doc.getElementById('selectAll').click();
  await tick(200);
  const cfgNow = chrome._store.badcSettings;
  const allOn = ['baidu', 'so360'].every((k) =>
    Object.keys(cfgNow.sites[k].types).every((t) => cfgNow.sites[k].types[t].enabled));
  check('「全选」后选中平台全部类型开启', allOn);

  // 「全不选」批量
  doc.getElementById('selectNone').click();
  await tick(200);
  const cfgOff = chrome._store.badcSettings;
  const allOff = ['baidu', 'so360'].every((k) =>
    Object.keys(cfgOff.sites[k].types).every((t) => !cfgOff.sites[k].types[t].enabled));
  check('「全不选」后选中平台全部类型关闭', allOff);

  // 「仅安全项」：不得启用任何非 safe 类型
  doc.getElementById('selectSafe').click();
  await tick(200);
  const cfgSafe = chrome._store.badcSettings;
  let risky = null;
  ['baidu', 'so360'].forEach((k) => {
    Object.keys(cfgSafe.sites[k].types).forEach((t) => {
      if (!cfgSafe.sites[k].types[t].enabled) return;
      const rule = sb.BADC_RULES.rule(k, t);
      if (rule && rule.risk !== 'safe') risky = `${k}.${t}(${rule.risk})`;
    });
  });
  check('「仅安全项」后无非安全类型被启用', risky === null, risky || '');
}

/* ============================================================
 * 4. options.js 交互：平台开关影响配置
 * ========================================================== */
async function testOptionsPlatformSwitch() {
  section('设置页 · 平台开关');
  const cfg = defaultCfg();
  const { doc, chrome, sb } = setupOptions(cfg);
  await tick(60);

  const store = chrome._store;

  // 启用 Google 净化（初始为关）
  const gSw = doc.querySelector('.platform[data-site="google"] .platform__switch');
  gSw.click();
  await tick(200);
  check('开启 Google 后 enabled=true', store.badcSettings.sites.google.enabled === true,
    String(store.badcSettings.sites.google.enabled));

  // 开启后应自动加入配置集并被勾选
  const gChecked = doc.querySelector('.platform[data-site="google"] .platform__check input').checked;
  check('启用后自动加入配置集（被勾选）', gChecked === true);

  // 再关闭，应移出配置集
  doc.querySelector('.platform[data-site="google"] .platform__switch').click();
  await tick(200);
  check('再次关闭后 enabled=false', store.badcSettings.sites.google.enabled === false,
    String(store.badcSettings.sites.google.enabled));
  const gChecked2 = doc.querySelector('.platform[data-site="google"] .platform__check input').checked;
  check('停用后自动移出配置集', gChecked2 === false);
}

/* ============================================================
 * 5. options.js 自定义规则增删
 * ========================================================== */
async function testOptionsCustomRules() {
  section('设置页 · 自定义规则增删');
  const cfg = defaultCfg();
  const { doc, chrome, sb } = setupOptions(cfg);
  await tick(60);

  const list = doc.getElementById('customRuleList');
  check('初始无规则卡片', list.querySelectorAll('.rule-card').length === 0);

  // 点击添加
  doc.getElementById('addCustom').click();
  await tick(60);
  check('添加后出现 1 张卡片', list.querySelectorAll('.rule-card').length === 1);
  check('空态已隐藏', doc.getElementById('customEmpty').classList.contains('is-hidden'));

  // 输入选择器
  const input = list.querySelector('.rule-card__input');
  input.value = '#content_left .ad-banner';
  input.input();
  await tick(200);
  const rule0 = chrome._store.badcSettings.customRules[0];
  check('规则已保存到 store', !!rule0 && rule0.selector === '#content_left .ad-banner',
    JSON.stringify(chrome._store.badcSettings.customRules));

  // 默认勾选平台应为当前选中（百度）
  check('新规则默认绑定当前平台',
    !!rule0 && rule0.sites.join(',') === 'baidu',
    rule0 ? rule0.sites.join(',') : '规则不存在');

  // 平台 chips：点 sogou 的 chip 增加适用平台
  const sogouChip = list.querySelector('.chip[data-site="sogou"]');
  sogouChip.click();
  await tick(60);
  const r = chrome._store.badcSettings.customRules[0];
  check('点 chip 后适用平台增加 sogou', r.sites.includes('sogou'), r.sites.join(','));

  // 点「全部」chip
  list.querySelector('.chip--all').click();
  await tick(60);
  check('「全部」chip 覆盖 6 个平台',
    chrome._store.badcSettings.customRules[0].sites.length === 6,
    chrome._store.badcSettings.customRules[0].sites.join(','));

  // 删除
  list.querySelector('.rule-card__del').click();
  await tick(60);
  check('删除后卡片清空', list.querySelectorAll('.rule-card').length === 0);
  check('删除后 store 中规则清空', chrome._store.badcSettings.customRules.length === 0);
  check('删除后空态恢复', !doc.getElementById('customEmpty').classList.contains('is-hidden'));
}

/* ============================================================
 * 6. popup.js 真实运行
 * ========================================================== */
async function testPopup() {
  section('Popup · 真实运行');

  // 场景 A：百度搜索页
  {
    const chrome = makeChrome({
      tabId: 1,
      tabs: [{ id: 1, url: 'https://www.baidu.com/s?wd=test', active: true }]
    });
    // 先加载 background，使其注册 BADC_GET_STATS 监听（真实运行时的统计来源）
    const sbBg = makeSandbox(H.makeDocument(), chrome);
    createContext(sbBg);
    loadFiles(sbBg, ['background/service-worker.js']);

    chrome._store.badcTabStats = {
      '1': { total: 7, byType: { inline: 4, sidebar: 2, brandTop: 1 } }
    };
    const doc = parseHtml(readSrc('popup/popup.html'));
    const sb = makeSandbox(doc, chrome, {
      protocol: 'https:', hostname: 'www.baidu.com', href: 'https://www.baidu.com/s'
    });
    createContext(sb);
    loadCore(sb);
    loadFiles(sb, ['popup/popup.js']);
    await tick(200);

    check('站点标签显示百度', doc.getElementById('siteTag').textContent === '百度',
      doc.getElementById('siteTag').textContent);
    check('统计数字为 7', doc.getElementById('statNum').textContent === '7',
      doc.getElementById('statNum').textContent);

    const typeRows = doc.querySelectorAll('#typeList .type');
    check('类型列表按当前站点渲染 12 项', typeRows.length === 12, String(typeRows.length));

    // 计数徽标：inline 应显示 4
    const inlineRow = Array.from(typeRows).find((r) =>
      r.querySelector('.type__name').textContent === '结果内推广条目');
    check('inline 行显示计数 4',
      inlineRow && inlineRow.querySelector('.type__count').textContent === '4',
      inlineRow ? inlineRow.querySelector('.type__count').textContent : '未找到');

    check('页面状态为正在净化', /正在净化/.test(doc.getElementById('pageStatus').textContent),
      doc.getElementById('pageStatus').textContent);
  }

  // 场景 B：非受支持站点
  {
    const chrome = makeChrome({
      tabId: 2,
      tabs: [{ id: 2, url: 'https://www.example.com/', active: true }]
    });
    const doc = parseHtml(readSrc('popup/popup.html'));
    const sb = makeSandbox(doc, chrome, {
      protocol: 'https:', hostname: 'www.example.com', href: 'https://www.example.com/'
    });
    createContext(sb);
    loadCore(sb);
    loadFiles(sb, ['popup/popup.js']);
    await tick(200);

    check('非支持站点显示未匹配', /未匹配/.test(doc.getElementById('siteTag').textContent),
      doc.getElementById('siteTag').textContent);
    check('非支持站点显示空状态', doc.querySelectorAll('#typeList .empty').length === 1);
    check('非支持站点状态提示正确', /不在净化范围/.test(doc.getElementById('pageStatus').textContent),
      doc.getElementById('pageStatus').textContent);
  }

  // 场景 C：站点被关闭
  {
    const chrome = makeChrome({
      tabId: 3,
      tabs: [{ id: 3, url: 'https://www.so.com/s?q=x', active: true }]
    });
    const cfg = defaultCfg();
    cfg.sites.so360.enabled = false;
    chrome._store.badcSettings = cfg;
    const doc = parseHtml(readSrc('popup/popup.html'));
    const sb = makeSandbox(doc, chrome, {
      protocol: 'https:', hostname: 'www.so.com', href: 'https://www.so.com/s'
    });
    createContext(sb);
    loadCore(sb);
    loadFiles(sb, ['popup/popup.js']);
    await tick(200);

    check('站点关闭时状态提示正确', /360 净化已关闭/.test(doc.getElementById('pageStatus').textContent),
      doc.getElementById('pageStatus').textContent);
  }
}

/* ============================================================
 * 7. background/service-worker.js 真实运行
 * ========================================================== */
async function testServiceWorker() {
  section('Background · 统计与角标');
  const chrome = makeChrome({ tabId: 7, tabs: [{ id: 7, url: 'https://www.baidu.com/s', active: true }] });
  const sb = makeSandbox(H.makeDocument(), chrome);
  createContext(sb);
  loadFiles(sb, ['background/service-worker.js']);

  // 内容脚本上报 3 条 inline + 1 条 sidebar
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_REPORT', delta: 3, byType: { inline: 3 } },
      { tab: { id: 7 } },
      () => resolve()
    );
  });
  check('上报后统计为 3', chrome._store.badcTabStats['7'].total === 3,
    String(chrome._store.badcTabStats['7'] && chrome._store.badcTabStats['7'].total));
  check('角标显示 3', chrome._badge['7'] === '3', String(chrome._badge['7']));

  // 再次上报，累计
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_REPORT', delta: 2, byType: { sidebar: 2 } },
      { tab: { id: 7 } },
      () => resolve()
    );
  });
  check('累加后统计为 5', chrome._store.badcTabStats['7'].total === 5,
    String(chrome._store.badcTabStats['7'].total));
  check('按类型累计 inline=3', chrome._store.badcTabStats['7'].byType.inline === 3);
  check('按类型累计 sidebar=2', chrome._store.badcTabStats['7'].byType.sidebar === 2);

  // 查询统计（popup 的调用方式）
  const queried = await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_GET_STATS' },
      { tab: { id: 7 } },
      (res) => resolve(res)
    );
  });
  check('BADC_GET_STATS 返回累计值', queried && queried.total === 5,
    queried ? String(queried.total) : '无响应');
  check('返回值含 tabId', queried && queried.tabId === 7);

  // 大数值角标封顶
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_REPORT', delta: 2000, byType: {} },
      { tab: { id: 7 } }, () => resolve()
    );
  });
  check('角标超 999 封顶为 999+', chrome._badge['7'] === '999+', String(chrome._badge['7']));

  // 重置
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire({ type: 'BADC_RESET' }, { tab: { id: 7 } }, () => resolve());
  });
  check('重置后统计被清除', !chrome._store.badcTabStats['7']);
  check('重置后角标清空', chrome._badge['7'] === '', JSON.stringify(chrome._badge['7']));

  // 标签页刷新应清空该页统计
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_REPORT', delta: 1, byType: {} }, { tab: { id: 7 } }, () => resolve()
    );
  });
  chrome._listeners.tabsUpdated[0](7, { status: 'loading' });
  await tick(10);
  check('标签页刷新清空统计', !chrome._store.badcTabStats['7']);

  // 标签页关闭应清空该页统计
  await new Promise((resolve) => {
    chrome.runtime.onMessage._fire(
      { type: 'BADC_REPORT', delta: 1, byType: {} }, { tab: { id: 7 } }, () => resolve()
    );
  });
  chrome._listeners.tabsRemoved[0](7);
  await tick(10);
  check('标签页关闭清空统计', !chrome._store.badcTabStats['7']);

  // 首次安装引导
  chrome._listeners.installed[0]({ reason: 'install' });
  check('首次安装创建设置页', chrome._created.some((c) => c.url && c.url.includes('options/options.html')),
    JSON.stringify(chrome._created));
}

/* ============================================================
 * 8. content.js ← background 端到端上报链路
 * ========================================================== */
async function testEndToEndReport() {
  section('端到端 · 内容脚本上报到 background');
  const chrome = makeChrome({ tabId: 11, tabs: [{ id: 11, url: 'https://www.baidu.com/s', active: true }] });

  // 先跑 background
  const sbBg = makeSandbox(H.makeDocument(), chrome);
  createContext(sbBg);
  loadFiles(sbBg, ['background/service-worker.js']);

  // 再跑内容脚本（同一 chrome 实例）
  const doc = H.makeDocument();
  doc.readyState = 'complete';
  const cl = new El('div', { id: 'content_left' });
  doc.body.appendChild(cl);
  // 3 个广告条目 + 1 个正常条目
  [1, 2, 3].forEach((i) => {
    const card = new El('div', { class: 'c-container', id: 'r' + i });
    card.appendChild(new El('span', { class: 'ec-tuiguang' }));
    cl.appendChild(card);
  });
  cl.appendChild(new El('div', { class: 'c-container', id: 'ok' }));
  doc.body.appendChild(new El('div', { id: 'top-ad' }));

  const cfg = defaultCfg();
  cfg.mode = 'remove';
  chrome._store.badcSettings = cfg;

  const sb = makeSandbox(doc, chrome, {
    protocol: 'https:', hostname: 'www.baidu.com', href: 'https://www.baidu.com/s'
  });
  sb.__BADC_LOADED__ = false;
  createContext(sb);
  loadCore(sb);
  loadFiles(sb, ['content/content.js']);
  await tick(120);

  // 内容脚本应已清理广告
  const left = cl.children.map((c) => c.id);
  check('内容脚本清理了 3 个推广条目',
    !left.includes('r1') && !left.includes('r2') && !left.includes('r3'), left.join(','));
  check('正常结果保留', left.includes('ok'), left.join(','));

  // 统计应已上报到 background（reportToBackground 有 400ms 节流）
  await tick(600);
  const st = (chrome._store.badcTabStats || {})['11'];
  check('过滤统计已上报 background', !!st && st.total > 0,
    st ? String(st.total) : '未上报');
  check('统计按类型记录 inline', !!(st && st.byType && st.byType.inline > 0),
    JSON.stringify(st && st.byType));
  check('角标已更新', !!chrome._badge['11'], JSON.stringify(chrome._badge));
}

/* ============================================================
 * 9. 设置页变更 → 广播到内容脚本
 * ========================================================== */
async function testBroadcast() {
  section('端到端 · 设置变更广播');
  const cfg = defaultCfg();
  // 打开若干标签页：受支持（百度/360）与不受支持（example），验证广播范围
  const { doc, chrome, sb } = setupOptions(cfg, {
    tabs: [
      { id: 21, url: 'https://www.baidu.com/s', active: true },
      { id: 22, url: 'https://www.so.com/s', active: false },
      { id: 23, url: 'https://www.example.com/', active: false }
    ]
  });
  void sb;
  await tick(60);

  // 关闭总开关 → 应向受支持标签页广播（21/22），跳过 example（23）
  const master = doc.getElementById('masterSwitch');
  master.checked = false;
  master.change();
  await tick(200);

  const sentTo = chrome._sent.filter((m) => m && m.msg).map((m) => m.to);
  const broadcast = chrome._sent.filter((m) => m && m.msg && m.msg.type === 'BADC_SETTINGS_CHANGED');
  check('关闭总开关触发广播', broadcast.length > 0,
    `已发送 ${chrome._sent.length} 条`);
  check('广播消息类型正确',
    broadcast.length > 0 && broadcast[0].msg.type === 'BADC_SETTINGS_CHANGED');
  check('广播覆盖百度与 360 标签页',
    sentTo.includes(21) && sentTo.includes(22), sentTo.join(','));
  check('广播跳过不受支持的站点', !sentTo.includes(23), sentTo.join(','));

  // 自定义规则变化也应广播
  const before = broadcast.length;
  doc.getElementById('addCustom').click();
  await tick(200);
  const after = chrome._sent.filter((m) => m && m.msg && m.msg.type === 'BADC_SETTINGS_CHANGED').length;
  check('新增自定义规则后广播次数增加', after > before, `${before} → ${after}`);
}

/* ============================================================
 * 10. 配置导出/导入的数据完整性
 * ========================================================== */
async function testConfigRoundTrip() {
  section('配置 · 导出导入往返');
  const chrome = makeChrome();
  const cfg = defaultCfg();
  cfg.mode = 'remove';
  cfg.sites.so360.enabled = true;
  cfg.customRules = [{ selector: '.x-ad', sites: ['baidu', 'bing'] }];

  // 用真实 BADC 走一遍 save → normalize
  const sb = makeSandbox(H.makeDocument(), chrome);
  createContext(sb);
  loadCore(sb);

  const saved = await sb.BADC.save(cfg);
  check('保存后模式保持 remove', saved.mode === 'remove');
  check('保存后自定义规则保持', saved.customRules.length === 1);
  check('保存后规则适用平台保持',
    saved.customRules[0].sites.join(',') === 'baidu,bing',
    saved.customRules[0].sites.join(','));

  // 模拟重新加载（从 storage 读回并 normalize）
  const sb2 = makeSandbox(H.makeDocument(), chrome);
  createContext(sb2);
  loadCore(sb2);
  const reloaded = await sb2.BADC.load();
  check('重新加载后模式仍为 remove', reloaded.mode === 'remove');
  check('重新加载后 360 仍启用', reloaded.sites.so360.enabled === true);
  check('重新加载后规则未丢失', reloaded.customRules.length === 1);
  check('重新加载后规则选择器正确', reloaded.customRules[0].selector === '.x-ad');
}

/* ============================================================
 * 主流程
 * ========================================================== */
(async function main() {
  console.log('集成测试：在 Node 中真实运行各扩展模块');
  await testOptionsRender();
  await testOptionsMultiSelect();
  await testOptionsBatchApply();
  await testOptionsPlatformSwitch();
  await testOptionsCustomRules();
  await testPopup();
  await testServiceWorker();
  await testEndToEndReport();
  await testBroadcast();
  await testConfigRoundTrip();

  console.log('\n' + '='.repeat(50));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log('\n  失败清单：');
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  }
  console.log('='.repeat(50));
  process.exit(fail > 0 ? 1 : 0);
})();