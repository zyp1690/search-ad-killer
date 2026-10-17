/**
 * content/content.js
 * 搜索引擎结果广告清理器（内容脚本），支持百度与 360 搜索。
 *
 * 设计要点：
 * 1. 在页面最早阶段（document_start）读取设置并立即注入 CSS，做到"零闪烁"。
 * 2. 用 MutationObserver 监听动态插入的节点，精准处理新节点而非全量重扫，避免性能抖动。
 * 3. 三种处理方式：hide（display:none）/ collapse（保留占位提示）/ remove（直接删节点）。
 * 4. 所有选择器均做 try-catch 保护，规则失效时静默跳过，绝不破坏页面。
 * 5. 规则按站点隔离，页面只加载当前站点（siteKey）的规则集，互不干扰。
 */
(function () {
  'use strict';

  if (window.__BADC_LOADED__) return;
  window.__BADC_LOADED__ = true;

  var BADC = globalThis.BADC;
  var RULES = globalThis.BADC_RULES;

  /** 状态 */
  var settings = null;
  /** 当前页面所属站点，由站点识别逻辑填充 */
  var siteKey = null;
  var siteCfg = null;
  var siteRules = [];
  /** 受保护节点：主容器/ body，任何规则都不得隐藏 */
  var protectedEls = [];

  var stats = { total: 0, byType: {} };
  var noticeHost = null;
  var observer = null;
  var pendingNodes = new Set();
  var flushTimer = null;
  var noticeCount = 0;

  var STYLE_ID = 'badc-style';
  var MARK_ATTR = 'data-badc';
  var NOTICE_CLASS = 'badc-notice';

  /* ============================================================
   * 1. 样式注入
   * ========================================================== */

  function buildCss() {
    var lines = [];
    var mode = settings.mode;

    if (mode === 'hide' || mode === 'remove') {
      // 仅注入"广告容器本身"的选择器，用于首屏即刻隐藏、杜绝闪烁。
      // 注意：不注入 badgeSelectors —— 角标只是卡片内的标记，隐藏角标并不能去掉整条广告。
      // 带祖先回溯（ancestor）的规则由 scan() 用 JS 精确定位卡片后处理。
      var selectors = collectContainerSelectors();
      if (selectors.length) {
        lines.push(selectors.join(',\n') + ' { display: none !important; }');
      }
    }

    if (settings.collapseGap) {
      // 收起"本扩展已标记且内容已被清空"的容器。
      // 只匹配 [data-badc] 节点，绝不触碰百度页面自身的空 div，避免误伤。
      lines.push('[data-badc]:empty { display: none !important; }');
    }

    return lines.join('\n');
  }

  /**
   * 汇总当前站点所有启用类型的"容器级"选择器。
   * 只包含无需祖先回溯、命中即广告整块的选择器。
   */
  function collectContainerSelectors() {
    var out = [];
    function pushSafe(sel) {
      if (!sel) return;
      try {
        document.querySelector(sel);
        out.push(sel);
      } catch (e) { /* 非法选择器，跳过 */ }
    }
    enabledRules().forEach(function (rule) {
      // 带 ancestor 且非 selfOnly 的规则交给 JS 处理（需先定位到卡片）
      if (rule.ancestor && !rule.selfOnly) return;
      (rule.containerSelectors || []).forEach(pushSafe);
      // wholeBlocks 需用户显式开启后才生效
      if (rule.wholeBlocks && isTypeEnabled(rule.id) && isWholeBlockOn(rule)) {
        rule.wholeBlocks.forEach(pushSafe);
      }
    });
    customSelectors().forEach(pushSafe);
    return out;
  }

  /**
   * 当前站点生效的自定义选择器（跨平台共享规则中筛选出属于本站点的）。
   * 仅 // 与 /* 开头视为注释；# 开头是合法的 ID 选择器。
   */
  function customSelectors() {
    if (!settings) return [];
    if (typeof BADC.selectorsForSite === 'function') {
      return BADC.selectorsForSite(settings, siteKey);
    }
    // 兜底：直接读取（结构异常时也不应抛错）
    var rules = settings.customRules || [];
    return rules.filter(function (r) {
      return r && r.sites && r.sites.indexOf(siteKey) !== -1;
    }).map(function (r) { return r.selector; });
  }

  /** 规则是否开启了「整块移除」附属开关 */
  function isWholeBlockOn(rule) {
    var t = siteCfg && siteCfg.types && siteCfg.types[rule.id];
    return !!(t && t.wholeBlock);
  }

  function injectStyle() {
    var css = buildCss();
    var el = document.getElementById(STYLE_ID);
    if (!css) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
  }

  /* ============================================================
   * 2. 设置与规则查询
   * ========================================================== */

  /** 某去除类型在当前站点是否开启 */
  function isTypeEnabled(typeId) {
    var t = siteCfg && siteCfg.types && siteCfg.types[typeId];
    return !!(t && t.enabled);
  }

  /** 当前站点已启用的规则集 */
  function enabledRules() {
    if (!siteRules || !siteRules.length) return [];
    return siteRules.filter(function (r) {
      return isTypeEnabled(r.id);
    });
  }

  /** 安全查询：非法选择器不抛错 */
  function safeQueryAll(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (e) {
      if (settings && settings.debug) console.warn('[BADC] 非法选择器:', selector, e);
      return [];
    }
  }

  /* ============================================================
   * 3. 核心：节点处理
   * ========================================================== */

  /** 判断元素是否应被过滤（含角标文案兜底） */
  function isAdElement(el, rule) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute(MARK_ATTR)) return false;

    // 结构化标记
    if (rule.badgeSelectors && rule.badgeSelectors.length) {
      for (var i = 0; i < rule.badgeSelectors.length; i++) {
        try {
          if (el.matches(rule.badgeSelectors[i])) return true;
        } catch (e) { /* ignore */ }
      }
    }

    // 角标文案兜底：元素本身文本极短且等于广告关键词
    if (rule.badgeTexts && rule.badgeTexts.length) {
      var txt = (el.textContent || '').trim();
      if (txt && txt.length <= 6 && rule.badgeTexts.indexOf(txt) !== -1) return true;
    }

    return false;
  }

  /** 从命中元素向上找到所属结果卡片 */
  function findCard(el, rule) {
    var maxUp = rule.maxUp || 6;
    var cur = el;
    for (var i = 0; i < maxUp && cur; i++) {
      cur = cur.parentElement;
      if (!cur || cur === document.body || cur === document.documentElement) break;
      // 向上回溯途中若撞到受保护容器，说明这条广告归属不可判定，放弃处理
      if (isProtected(cur)) return null;
      if (rule.ancestor) {
        try {
          if (cur.matches(rule.ancestor)) return cur;
        } catch (e) { /* ignore */ }
      } else {
        return cur;
      }
    }
    return el;
  }

  /** 是否为受保护节点（页面骨架，任何规则都不得隐藏） */
  function isProtected(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return true;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'FORM') return true;
    // 搜索框、表单容器等交互区域
    if (el.id && /^(kw|wd|search|form|hd|header|wrapper|searchForm)$/i.test(el.id)) return true;
    if (protectedEls.indexOf(el) !== -1) return true;
    return false;
  }

  /** 缓存当前站点的主容器节点，作为受保护对象 */
  function collectProtected() {
    protectedEls = [];
    var site = RULES.SITES[siteKey];
    if (!site || !site.mainContainers) return;
    site.mainContainers.forEach(function (sel) {
      safeQueryAll(document, sel).forEach(function (el) {
        if (protectedEls.indexOf(el) === -1) protectedEls.push(el);
      });
    });
  }

  /** 处理单个命中元素 */
  function processHit(el, rule) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute(MARK_ATTR)) return;
    if (isProtected(el)) return;

    var target = rule.ancestor ? findCard(el, rule) : el;
    if (!target || target.hasAttribute(MARK_ATTR)) return;
    if (isProtected(target)) return;

    if (settings.mode === 'remove') {
      try {
        target.remove();
      } catch (e) { /* 忽略 */ }
      markCount(rule.id);
      return;
    }

    if (settings.mode === 'collapse') {
      collapse(target, rule);
    } else {
      hideOne(target, rule.id);
    }
    markCount(rule.id);
  }

  /**
   * 隐藏单个节点：记录原始内联样式，便于"全部展开"时无损还原。
   * 用 !important 行内样式对抗百度自身 CSS，确保隐藏生效。
   * @param {Element} target 目标节点
   * @param {string} ruleId  命中的规则 id
   */
  function hideOne(target, ruleId) {
    // 先备份原始 style，再打标记，最后隐藏，顺序不可颠倒
    target.dataset.badcPrevStyle = target.getAttribute('style') || '';
    target.setAttribute(MARK_ATTR, ruleId);
    target.style.setProperty('display', 'none', 'important');
  }

  /** 折叠：压缩高度并插入可展开的提示条 */
  function collapse(target, rule) {
    // 备份完整的原始内联样式，所有还原动作都基于它，保证无损
    target.dataset.badcPrevStyle = target.getAttribute('style') || '';
    target.setAttribute(MARK_ATTR, rule.id);

    target.style.setProperty('height', '0', 'important');
    target.style.setProperty('min-height', '0', 'important');
    target.style.setProperty('overflow', 'hidden', 'important');
    target.style.setProperty('margin', '0', 'important');
    target.style.setProperty('padding', '0', 'important');
    target.style.setProperty('border', 'none', 'important');
    target.style.setProperty('pointer-events', 'none', 'important');

    if (settings.showNotice && target.parentElement) {
      insertNotice(target, rule);
    }
  }

  /** 还原单个节点的内联样式（hide / collapse 通用） */
  function restoreStyle(target) {
    var prev = target.dataset.badcPrevStyle;
    if (prev) {
      target.setAttribute('style', prev);
    } else {
      //原本没有内联样式，直接整体移除
      target.removeAttribute('style');
    }
    delete target.dataset.badcPrevStyle;
  }

  /** 还原单个节点 */
  function expand(target) {
    if (!target || !target.hasAttribute(MARK_ATTR)) return;

    var ruleId = target.getAttribute(MARK_ATTR);
    var rule = RULES.rule(siteKey, ruleId);

    if (settings && settings.mode === 'remove') {
      // 移除模式下节点已从 DOM 摘除，无需还原
      return;
    }

    restoreStyle(target);
    target.removeAttribute(MARK_ATTR);

    // 移除该节点下方相邻的提示条
    var next = target.nextElementSibling;
    if (next && next.classList && next.classList.contains(NOTICE_CLASS)) {
      next.remove();
    }
    if (rule) stats.byType[rule.id] = Math.max(0, (stats.byType[rule.id] || 0) - 1);
  }

  /* ============================================================
   * 4. 提示条
   * ========================================================== */

  function insertNotice(target, rule) {
    var parent = target.parentElement;
    if (!parent) return;
    // 避免重复插入
    var prev = target.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains(NOTICE_CLASS)) return;

    var box = document.createElement('div');
    box.className = NOTICE_CLASS + ' badc-notice--' + rule.id;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'badc-notice__btn';
    btn.textContent = '已过滤广告 · 展开';
    btn.title = '点击临时展开这条广告（刷新页面后恢复过滤）';

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'badc-notice__close';
    close.title = '关闭提示';
    close.textContent = '×';

    close.addEventListener('click', function (e) {
      e.stopPropagation();
      box.remove();
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      expand(target);
      box.remove();
    });

    box.appendChild(btn);
    box.appendChild(close);
    parent.insertBefore(box, target);

    if (settings.autoFadeNotice) {
      setTimeout(function () {
        box.classList.add('badc-notice--faded');
      }, 6000);
    }
  }

  /* ============================================================
   * 5. 扫描
   * ========================================================== */

  function scan(root) {
    if (!settings || !settings.enabled) return;
    if (!siteCfg || !siteCfg.enabled) return;
    var scope = root && root.nodeType === 1 ? root : document;
    var rules = enabledRules();

    rules.forEach(function (rule) {
      // 整块移除：仅在用户显式开启该附属开关时执行
      if (rule.wholeBlocks && isWholeBlockOn(rule)) {
        rule.wholeBlocks.forEach(function (sel) {
          safeQueryAll(scope, sel).forEach(function (el) {
            if (el.hasAttribute(MARK_ATTR)) return;
            if (isProtected(el)) return;
            applyWhole(el, rule);
          });
        });
      }

      // 广告容器：默认命中整块；若规则声明 selfOnly，则仅角标才回溯卡片
      safeQueryAll(scope, joinSelectors(rule.containerSelectors)).forEach(function (el) {
        // selfOnly：容器选择器已精确指向广告本身（多带作用域限定），
        // 不应再向上回溯，否则会因撞到受保护容器而放弃处理。
        if (rule.selfOnly || !rule.ancestor) applyWhole(el, rule);
        else processHit(el, rule);
      });

      // 角标：命中后向上找到卡片
      if (rule.badgeSelectors && rule.badgeSelectors.length) {
        safeQueryAll(scope, joinSelectors(rule.badgeSelectors)).forEach(function (el) {
          if (isAdElement(el, rule)) processHit(el, rule);
        });
      }

      // 推广链接特征
      if (rule.linkHints && rule.linkHints.length) {
        safeQueryAll(scope, joinSelectors(rule.linkHints)).forEach(function (el) {
          processHit(el, rule);
        });
      }
    });

    // 自定义规则：命中即广告整块
    customSelectors().forEach(function (sel) {
      safeQueryAll(scope, sel).forEach(function (el) {
        applyWhole(el, { id: 'custom' });
      });
    });

    updateNotice();
  }

  /** 整块节点处理（无 ancestor 的规则，命中即广告本身） */
  function applyWhole(el, rule) {
    if (!el || el.hasAttribute(MARK_ATTR)) return;
    if (isProtected(el)) return;

    if (settings.mode === 'remove') {
      try { el.remove(); } catch (e) { /* ignore */ }
      markCount(rule.id);
      return;
    }
    if (settings.mode === 'hide') {
      hideOne(el, rule.id);
    } else {
      collapse(el, rule);
    }
    markCount(rule.id);
  }

  function joinSelectors(list) {
    if (!list || !list.length) return '';
    return list.join(',');
  }

  function markCount(typeId) {
    stats.total += 1;
    stats.byType[typeId] = (stats.byType[typeId] || 0) + 1;
    if (!noticeCount) noticeCount = 1;
    pendingByType[typeId] = (pendingByType[typeId] || 0) + 1;
    reportToBackground();
  }

  /** 向后台上报统计（节流，避免频繁写存储） */
  var reportTimer = null;
  var pendingDelta = 0;
  var pendingByType = {};

  function reportToBackground() {
    pendingDelta += 1;
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = null;
      var payload = { type: 'BADC_REPORT', delta: pendingDelta, byType: pendingByType };
      pendingDelta = 0;
      pendingByType = {};
      try {
        chrome.runtime.sendMessage(payload, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 扩展可能已重载，忽略 */ }
    }, 400);
  }

  /* ============================================================
   * 6. 全局提示（页面顶部）
   * ========================================================== */

  function ensureNoticeHost() {
    if (noticeHost && noticeHost.isConnected) return noticeHost;
    var host = document.createElement('div');
    host.id = 'badc-notice-host';
    var bar = document.createElement('div');
    bar.className = 'badc-bar';
    bar.innerHTML =
      '<span class="badc-bar__icon">🛡</span>' +
      '<span class="badc-bar__text">百度净化：已过滤 <b id="badc-bar-count">0</b> 项广告</span>' +
      '<button type="button" class="badc-bar__btn" id="badc-bar-restore">全部展开</button>' +
      '<button type="button" class="badc-bar__close" id="badc-bar-close">×</button>';

    bar.querySelector('#badc-bar-restore').addEventListener('click', expandAll);
    bar.querySelector('#badc-bar-close').addEventListener('click', function () {
      host.remove();
      noticeHost = null;
      noticeCount = 0;
    });

    host.appendChild(bar);
    return host;
  }

  function updateNotice() {
    if (!settings || !settings.showNotice) return;
    if (stats.total <= 0) return;
    if (noticeHost && noticeHost.isConnected) return;

    var whenReady = function () {
      if (document.body) {
        noticeHost = ensureNoticeHost();
        document.body.appendChild(noticeHost);
        var num = noticeHost.querySelector('#badc-bar-count');
        if (num) num.textContent = String(stats.total);
      }
    };
    if (document.body) whenReady();
    else document.addEventListener('DOMContentLoaded', whenReady);
  }

  function expandAll() {
    var marked = safeQueryAll(document, '[' + MARK_ATTR + ']');
    marked.forEach(expand);
    safeQueryAll(document, '.' + NOTICE_CLASS).forEach(function (n) { n.remove(); });
    if (noticeHost) { noticeHost.remove(); noticeHost = null; }
    noticeCount = 0;
    stats.total = 0;
    stats.byType = {};
  }

  /* ============================================================
   * 7. DOM 监听
   * ========================================================== */

  function scheduleScan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute && node.hasAttribute(MARK_ATTR)) return;
    if (node.classList && node.classList.contains(NOTICE_CLASS)) return;

    pendingNodes.add(node);
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      var nodes = Array.from(pendingNodes);
      pendingNodes.clear();
      nodes.forEach(function (n) {
        if (n.isConnected) scan(n);
      });
    }, 120);
  }

  function startObserver() {
    if (observer || !settings || !settings.enabled) return;
    var target = document.body || document.documentElement;
    if (!target) return;

    observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, scheduleScan);
      });
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  /* ============================================================
   * 8. 生命周期
   * ========================================================== */

  /** 判断当前页面是否属于受支持的搜索站点 */
  function detectSite() {
    var loc = location;
    if (!/^https?:$/.test(loc.protocol)) return null;
    return BADC.siteOfHost(loc.hostname);
  }

  function bootstrap() {
    siteKey = detectSite();
    // 非支持站点（如贴吧、地图）直接退出，不做任何处理
    if (!siteKey) return;

    BADC.load().then(function (cfg) {
      settings = cfg;
      siteCfg = settings.sites ? settings.sites[siteKey] : null;
      siteRules = RULES.forSite(siteKey);
      if (!settings.enabled || !siteCfg || !siteCfg.enabled) {
        stopObserver();
        return;
      }
      collectProtected();
      injectStyle();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          collectProtected();
          scan(document);
          startObserver();
        });
      } else {
        scan(document);
        startObserver();
      }
    });

    // 设置变更实时生效（两条通道：storage 变化 + popup/设置页主动广播）
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[BADC.STORAGE_KEY]) return;
      applySettings();
    });

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'BADC_SETTINGS_CHANGED') return;
      applySettings();
      sendResponse({ ok: true });
    });
  }

  /** 重新加载设置并重建过滤状态 */
  function applySettings() {
    BADC.clearCache();
    BADC.load().then(function (next) {
      resetAll();
      settings = next;
      siteCfg = settings.sites ? settings.sites[siteKey] : null;
      if (!settings.enabled || !siteCfg || !siteCfg.enabled) {
        stopObserver();
        return;
      }
      collectProtected();
      injectStyle();
      if (document.body) {
        scan(document);
        startObserver();
      }
    });
  }

  /** 设置变更前清理所有已应用的过滤 */
  function resetAll() {
    safeQueryAll(document, '[' + MARK_ATTR + ']').forEach(function (el) {
      restoreStyle(el);
      el.removeAttribute(MARK_ATTR);
    });
    safeQueryAll(document, '.' + NOTICE_CLASS).forEach(function (n) { n.remove(); });
    var st = document.getElementById(STYLE_ID);
    if (st) st.remove();
    if (noticeHost) { noticeHost.remove(); noticeHost = null; }
    stats.total = 0;
    stats.byType = {};
    noticeCount = 0;
  }

  bootstrap();
})();