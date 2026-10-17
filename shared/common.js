/**
 * shared/common.js
 * 设置项默认值 + 存储读写封装。
 * 被 content script、popup、options 页共用。
 * 以 globalThis.BADC 暴露，避免污染页面全局命名空间。
 *
 * 配置结构（v3）：
 *   {
 *     enabled, mode, showNotice, autoFadeNotice, collapseGap, debug,
 *     sites: {
 *       baidu: { enabled, types: {...} },
 *       so360: { enabled, types: {...} }
 *     },
 *     // 跨平台共享的自定义规则（v3 新增）
 *     customRules: [{ selector: '.ad-banner', sites: ['baidu','bing'] }]
 *   }
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'badcSettings';

  /**
   * 站点定义。key 与 rules/rules.js 中 SITES 的 key 一一对应。
   * hosts 用于内容脚本判定当前页面归属站点。
   * enabledByDefault：是否默认开启该站点的净化（Google 默认关闭，
   * 因其结果页结构特殊、广告判定依赖英文 aria-label）。
   */
  var SITE_DEFS = [
    {
      key: 'baidu',
      name: '百度',
      short: '百度',
      hosts: ['www.baidu.com', 'm.baidu.com'],
      /** 这些子站不处理 */
      excludeHosts: ['tieba.baidu.com', 'map.baidu.com', 'image.baidu.com', 'video.baidu.com',
        'music.baidu.com', 'wenku.baidu.com', 'baike.baidu.com', 'zhidao.baidu.com',
        'ai.baidu.com', 'hao.baidu.com']
    },
    {
      key: 'so360',
      name: '360 搜索',
      short: '360',
      hosts: ['www.so.com', 'm.so.com', 'so.com'],
      excludeHosts: ['image.so.com', 'map.so.com', 'video.so.com', 'news.so.com',
        'hao.360.com', 'wenku.so.com', 'baike.so.com']
    },
    {
      key: 'sogou',
      name: '搜狗搜索',
      short: '搜狗',
      hosts: ['www.sogou.com', 'sogou.com', 'm.sogou.com'],
      excludeHosts: ['pic.sogou.com', 'map.sogou.com', 'video.sogou.com', 'news.sogou.com',
        'zhihu.sogou.com', 'weixin.sogou.com']
    },
    {
      key: 'bing',
      name: '必应',
      short: '必应',
      hosts: ['www.bing.com', 'cn.bing.com', 'bing.com'],
      excludeHosts: ['images.bing.com', 'maps.bing.com', 'videos.bing.com', 'news.bing.com']
    },
    {
      key: 'google',
      name: 'Google',
      short: 'Google',
      hosts: ['www.google.com', 'google.com'],
      excludeHosts: ['images.google.com', 'maps.google.com', 'news.google.com',
        'scholar.google.com', 'books.google.com', 'mail.google.com', 'drive.google.com'],
      /** 默认关闭：广告判定依赖英文文案，误判风险高于其他引擎 */
      enabledByDefault: false
    },
    {
      key: 'ddg',
      name: 'DuckDuckGo',
      short: 'DDG',
      hosts: ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'],
      excludeHosts: ['images.duckduckgo.com', 'maps.duckduckgo.com'],
      /** 默认关闭：国内访问稳定性因网络环境而异 */
      enabledByDefault: false
    }
  ];

  var DEFAULTS = {
    enabled: true,
    /** hide | collapse | remove */
    mode: 'collapse',
    /** 折叠时是否显示"已过滤 N 项"提示条 */
    showNotice: true,
    /** 提示条自动淡出 */
    autoFadeNotice: true,
    /** 清理后修正因广告消失造成的空白高度 */
    collapseGap: true,
    /** 调试模式 */
    debug: false,
    /** 各站点配置 */
    sites: {},
    /**
     * 用户自定义规则：跨平台共享。
     * 结构 [{ selector: '.ad-banner', sites: ['baidu','bing'] }, ...]
     * 一条规则可同时作用于多个平台，避免为每个平台重复书写。
     */
    customRules: []
  };

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function ruleListOf(siteKey) {
    var R = globalThis.BADC_RULES;
    if (!R) return [];
    var site = R.SITES && R.SITES[siteKey];
    return site ? site.rules : [];
  }

  /** 生成某站点的默认类型开关 */
  function defaultTypesFor(siteKey) {
    var types = {};
    ruleListOf(siteKey).forEach(function (rule) {
      types[rule.id] = { enabled: rule.defaultEnabled !== false };
      // sidebar 类型的附属开关：整块移除右侧栏
      if (rule.id === 'sidebar') types[rule.id].wholeBlock = false;
    });
    return types;
  }

  /** 生成一份完整的默认设置 */
  function buildDefaults() {
    var base = clone(DEFAULTS);
    base.sites = {};
    base.customRules = [];
    SITE_DEFS.forEach(function (site) {
      base.sites[site.key] = {
        enabled: site.enabledByDefault !== false,
        types: defaultTypesFor(site.key)
      };
    });
    return base;
  }

  var VALID_KEYS = null;
  function validSiteKeys() {
    if (!VALID_KEYS) VALID_KEYS = SITE_DEFS.map(function (s) { return s.key; });
    return VALID_KEYS;
  }

  /**
   * 把旧版「每平台一个 customSelectors 字符串」迁移为新版跨平台规则数组。
   * 迁移后原字符串语义保留：每行变成一条规则，仅作用于原平台。
   */
  function migrateLegacySelectors(legacySites) {
    var rules = [];
    Object.keys(legacySites || {}).forEach(function (key) {
      var src = legacySites[key];
      if (!src || typeof src.customSelectors !== 'string') return;
      splitSelectorLines(src.customSelectors).forEach(function (sel) {
        rules.push({ selector: sel, sites: [key] });
      });
    });
    return rules;
  }

  /**
   * 拆分自定义选择器文本为有效选择器数组。
   * 仅 // 与 /* 开头视为注释；# 开头是合法的 ID 选择器，不可误杀。
   */
  function splitSelectorLines(text) {
    if (!text) return [];
    return String(text)
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) {
        return l && l.slice(0, 2) !== '//' && l.slice(0, 2) !== '/*';
      });
  }

  /** 规范化 customRules 数组 */
  function normalizeCustomRules(input) {
    if (!Array.isArray(input)) return [];
    var out = [];
    var seen = {};
    input.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var sel = String(r.selector || '').trim();
      if (!sel) return;
      if (sel.slice(0, 2) === '//' || sel.slice(0, 2) === '/*') return;
      var sites = Array.isArray(r.sites) ? r.sites.filter(function (k) {
        return validSiteKeys().indexOf(k) !== -1;
      }) : [];
      // 未指定平台时默认全平台生效
      if (!sites.length) sites = validSiteKeys().slice();
      var key = sel + '||' + sites.join(',');
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ selector: sel, sites: sites });
    });
    return out;
  }

  /** 用默认值补齐缺失字段，兼容旧版本存储 */
  function normalize(input) {
    var out = buildDefaults();
    if (!input || typeof input !== 'object') return out;

    ['enabled', 'mode', 'showNotice', 'autoFadeNotice', 'collapseGap', 'debug'].forEach(function (key) {
      if (input[key] !== undefined) out[key] = input[key];
    });

    // v1 兼容：旧的顶层 types / customSelectors 归入 baidu 站点
    var hasSites = (input.sites && typeof input.sites === 'object');
    if (!hasSites && input.types) {
      out.sites.baidu.types = normalizeTypes(input.types, defaultTypesFor('baidu'));
    }

    // v2 兼容：per-site customSelectors 字符串 → 跨平台规则数组
    if (Array.isArray(input.customRules)) {
      out.customRules = normalizeCustomRules(input.customRules);
    } else if (hasSites) {
      out.customRules = normalizeCustomRules(migrateLegacySelectors(input.sites));
    } else if (typeof input.customSelectors === 'string') {
      out.customRules = normalizeCustomRules(migrateLegacySelectors({
        baidu: { customSelectors: input.customSelectors }
      }));
    }

    // 站点配置覆盖默认值
    if (hasSites) {
      Object.keys(out.sites).forEach(function (key) {
        var src = input.sites[key];
        if (!src || typeof src !== 'object') return;
        if (typeof src.enabled === 'boolean') out.sites[key].enabled = src.enabled;
        if (src.types) {
          out.sites[key].types = normalizeTypes(src.types, defaultTypesFor(key));
        }
      });
    }
    return out;
  }

  /** 取得某平台生效的自定义选择器（供内容脚本使用） */
  function selectorsForSite(settings, siteKey) {
    var rules = (settings && settings.customRules) || [];
    return rules.filter(function (r) {
      return r.sites && r.sites.indexOf(siteKey) !== -1;
    }).map(function (r) {
      return r.selector;
    });
  }

  /** 把任意来源的 types 对象补齐为完整结构 */
  function normalizeTypes(input, base) {
    if (!input || typeof input !== 'object') return base;
    Object.keys(base).forEach(function (id) {
      var src = input[id];
      if (!src || typeof src !== 'object') return;
      if (typeof src.enabled === 'boolean') base[id].enabled = src.enabled;
      if (typeof src.wholeBlock === 'boolean') base[id].wholeBlock = src.wholeBlock;
    });
    return base;
  }

  var memoryCache = null;

  function load() {
    if (memoryCache) return Promise.resolve(memoryCache);
    return new Promise(function (resolve) {
      chrome.storage.local.get(STORAGE_KEY, function (data) {
        var settings = normalize(data && data[STORAGE_KEY]);
        memoryCache = settings;
        resolve(settings);
      });
    });
  }

  function save(settings) {
    var next = normalize(settings);
    memoryCache = next;
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [STORAGE_KEY]: next }, function () {
        resolve(next);
      });
    });
  }

  function clearCache() {
    memoryCache = null;
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[STORAGE_KEY]) {
      memoryCache = null;
    }
  });

  /** 根据 hostname 判断所属站点 key，未匹配返回 null */
  function siteOfHost(hostname) {
    var host = String(hostname || '').toLowerCase();
    for (var i = 0; i < SITE_DEFS.length; i++) {
      var site = SITE_DEFS[i];
      var matched = site.hosts.some(function (h) {
        return host === h || host.endsWith('.' + h);
      });
      if (!matched) continue;
      // 命中排除子站则不算
      var excluded = (site.excludeHosts || []).some(function (h) {
        return host === h || host.endsWith('.' + h);
      });
      if (excluded) return null;
      return site.key;
    }
    return null;
  }

  globalThis.BADC = {
    STORAGE_KEY: STORAGE_KEY,
    SITE_DEFS: SITE_DEFS,
    DEFAULTS: DEFAULTS,
    buildDefaults: buildDefaults,
    normalize: normalize,
    normalizeCustomRules: normalizeCustomRules,
    splitSelectorLines: splitSelectorLines,
    selectorsForSite: selectorsForSite,
    load: load,
    save: save,
    clearCache: clearCache,
    siteOfHost: siteOfHost
  };
})();