/**
 * options/options.js
 * 完整设置页逻辑。所有修改即时保存并广播到内容脚本，无需手动点保存。
 *
 * UI 结构：
 *   1. 平台开关矩阵：一眼看清哪些平台已启用，点击平台名切换下方类型配置
 *   2. 类型配置区：只展示当前选中平台的去除类型，互不干扰
 */

(function () {
  'use strict';

  var BADC = globalThis.BADC;
  var RULES = globalThis.BADC_RULES;

  var settings = null;
  var saveTimer = null;
  /** 当前正在配置的平台（可多选，勾选会同时应用到这些平台） */
  var selectedSites = [BADC.SITE_DEFS[0].key];

  var $master = document.getElementById('masterSwitch');
  var $modeGrid = document.getElementById('modeGrid');
  var $platformGrid = document.getElementById('platformGrid');
  var $siteName = document.getElementById('siteName');
  var $siteMeta = document.getElementById('siteMeta');
  var $ruleList = document.getElementById('ruleList');
  var $customList = document.getElementById('customRuleList');
  var $customEmpty = document.getElementById('customEmpty');
  var $customHint = document.getElementById('customHint');
  var $saveBar = document.getElementById('saveBar');

  var RISK_LABEL = {
    safe: { text: '低风险', cls: 'tag--safe' },
    careful: { text: '谨慎', cls: 'tag--careful' },
    aggressive: { text: '激进', cls: 'tag--aggressive' }
  };

  /* ---------- 辅助 ---------- */
  function siteDef(key) {
    return BADC.SITE_DEFS.filter(function (s) { return s.key === key; })[0];
  }
  function siteCfgOf(key) {
    return settings.sites && settings.sites[key];
  }
  function siteRules(key) {
    return RULES.forSite(key);
  }
  /** 当前配置的平台列表（去重、剔除非法 key） */
  function currentSites() {
    var valid = BADC.SITE_DEFS.map(function (d) { return d.key; });
    var out = [];
    selectedSites.forEach(function (k) {
      if (valid.indexOf(k) !== -1 && out.indexOf(k) === -1) out.push(k);
    });
    return out;
  }
  /** 当前配置的平台配置对象列表 */
  function currentCfgs() {
    return currentSites().map(siteCfgOf).filter(Boolean);
  }
  /** 由配置对象反查其平台 key（selectSafe 需要按平台取规则风险） */
  function cfgKeyOf(cfg) {
    var hit = null;
    BADC.SITE_DEFS.forEach(function (d) {
      if (siteCfgOf(d.key) === cfg) hit = d.key;
    });
    return hit;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    BADC.load().then(function (cfg) {
      settings = cfg;
      renderAll();
      bind();
    });
  }

  function bind() {
    $master.addEventListener('change', function () {
      settings.enabled = $master.checked;
      save();
    });

    $modeGrid.addEventListener('change', function (e) {
      if (e.target.name === 'mode') {
        settings.mode = e.target.value;
        save();
      }
    });

    // 平台卡片：点复选框=加入/移出配置；点右侧开关=启用/停用净化
    $platformGrid.addEventListener('click', function (e) {
      var card = e.target.closest('.platform');
      if (!card) return;
      var key = card.dataset.site;

      // 右侧开关只管净化启用
      if (e.target.closest('.platform__switch')) {
        e.stopPropagation();
        var c = siteCfgOf(key);
        if (!c) return;
        c.enabled = !c.enabled;
        // 停用净化即移出配置集；启用则加入
        if (c.enabled) {
          if (selectedSites.indexOf(key) === -1) selectedSites.push(key);
        } else if (selectedSites.length > 1) {
          selectedSites = selectedSites.filter(function (k) { return k !== key; });
        }
        renderAll();
        save();
        return;
      }

      // 复选框/卡片其余区域：切换配置选中
      // 原生 checkbox 会自行切换状态，需阻止默认，统一由 toggleSite 驱动
      if (e.target.closest('.platform__check')) e.preventDefault();
      toggleSite(key);
    });

    // 平台级快捷操作
    document.getElementById('selectAllSites').addEventListener('click', function () {
      selectedSites = BADC.SITE_DEFS.map(function (d) { return d.key; });
      renderAll();
      save();
    });

    document.getElementById('clearSites').addEventListener('click', function () {
      selectedSites = [BADC.SITE_DEFS[0].key];
      renderAll();
      save();
    });

    // 类型勾选：应用到所有选中平台中拥有该类型的平台
    $ruleList.addEventListener('change', function (e) {
      var input = e.target.closest('input[data-type]');
      if (!input) return;
      var on = input.checked;
      currentSites().forEach(function (key) {
        var c = siteCfgOf(key);
        if (!c || !c.types) return;
        var t = c.types[input.dataset.type];
        if (!t) return;   // 该平台无此类型，跳过
        if (input.dataset.field === 'wholeBlock') t.wholeBlock = on;
        else t.enabled = on;
      });
      save();
    });

    // 自定义规则：选择器输入
    $customList.addEventListener('input', function (e) {
      var input = e.target.closest('.rule-card__input');
      if (!input) return;
      var rule = findRule(input.dataset.idx);
      if (!rule) return;
      rule.selector = input.value;
      updateCustomHint();
      save(true);
    });

    // 自定义规则：平台多选 chips
    $customList.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (chip && chip.dataset.idx !== undefined) {
        var r = findRule(chip.dataset.idx);
        if (!r) return;

        // 「全部」chip：一次性切换所有平台
        if (chip.classList.contains('chip--all')) {
          var all = BADC.SITE_DEFS.map(function (d) { return d.key; });
          var allOn = all.every(function (k) { return r.sites.indexOf(k) !== -1; });
          r.sites = allOn ? [] : all.slice();
          if (!r.sites.length) r.sites = [currentSites()[0] || 'baidu'];   // 至少保留一个
          save();
          renderCustomRules();
          return;
        }

        var key = chip.dataset.site;
        var i = r.sites.indexOf(key);
        if (i === -1) r.sites.push(key);
        else r.sites.splice(i, 1);
        // 规则不能为空平台集合，否则等于禁用
        if (!r.sites.length) r.sites.push(key);
        save();
        renderCustomRules();
        return;
      }
      var del = e.target.closest('.rule-card__del');
      if (del) {
        var idx = parseInt(del.dataset.idx, 10);
        settings.customRules.splice(idx, 1);
        save();
        renderCustomRules();
      }
    });

    // 平台 chip 支持事件委托后，无需单独绑定

    document.getElementById('addCustom').addEventListener('click', function () {
      // 新增规则默认只作用于当前选中的平台（单选时即该平台）
      settings.customRules.push({
        selector: '',
        sites: currentSites().length === 1 ? currentSites() : currentSites().slice()
      });
      save();
      renderCustomRules();
      // 聚焦到新规则输入框
      var inputs = $customList.querySelectorAll('.rule-card__input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    document.getElementById('applyToAll').addEventListener('click', function () {
      if (!settings.customRules.length) {
        showSaved('还没有规则可应用');
        return;
      }
      var all = BADC.SITE_DEFS.map(function (d) { return d.key; });
      settings.customRules.forEach(function (r) { r.sites = all.slice(); });
      save();
      renderCustomRules();
      showSaved('已应用到全部 ' + all.length + ' 个平台');
    });

    document.getElementById('optNotice').addEventListener('change', function (e) {
      settings.showNotice = e.target.checked; save();
    });
    document.getElementById('optFade').addEventListener('change', function (e) {
      settings.autoFadeNotice = e.target.checked; save();
    });
    document.getElementById('optGap').addEventListener('change', function (e) {
      settings.collapseGap = e.target.checked; save();
    });
    document.getElementById('optDebug').addEventListener('change', function (e) {
      settings.debug = e.target.checked; save();
    });

    // 批量操作：作用于所有选中的平台
    document.getElementById('selectAll').addEventListener('click', function () {
      currentCfgs().forEach(function (c) {
        Object.keys(c.types || {}).forEach(function (id) { c.types[id].enabled = true; });
      });
      renderRules(); save();
    });
    document.getElementById('selectSafe').addEventListener('click', function () {
      currentCfgs().forEach(function (c) {
        Object.keys(c.types || {}).forEach(function (id) {
          var rule = RULES.rule(cfgKeyOf(c), id);
          c.types[id].enabled = !!rule && rule.risk === 'safe';
        });
      });
      renderRules(); save();
    });
    document.getElementById('selectNone').addEventListener('click', function () {
      currentCfgs().forEach(function (c) {
        Object.keys(c.types || {}).forEach(function (id) { c.types[id].enabled = false; });
      });
      renderRules(); save();
    });

    document.getElementById('exportBtn').addEventListener('click', exportConfig);
    document.getElementById('importBtn').addEventListener('click', importConfig);
    document.getElementById('resetBtn').addEventListener('click', function () {
      if (!confirm('确定要恢复默认设置吗？所有自定义配置将被清空。')) return;
      settings = BADC.buildDefaults();
      BADC.save(settings).then(function (saved) {
        settings = saved;
        renderAll();
        save();
        showSaved('已恢复默认设置');
      });
    });
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    $master.checked = !!settings.enabled;

    Array.prototype.forEach.call($modeGrid.querySelectorAll('input[name="mode"]'), function (r) {
      r.checked = r.value === settings.mode;
    });

    renderPlatformGrid();
    renderSiteSection();
    // 自定义规则为跨平台全局列表，平台切换时无需重绘
    renderCustomRules();

    document.getElementById('optNotice').checked = !!settings.showNotice;
    document.getElementById('optFade').checked = !!settings.autoFadeNotice;
    document.getElementById('optGap').checked = !!settings.collapseGap;
    document.getElementById('optDebug').checked = !!settings.debug;
  }

/**
   * 切换某平台是否加入本次配置。
   * 配置集至少保留一个平台，否则类型配置区将无从渲染。
   */
  function toggleSite(key) {
    var i = selectedSites.indexOf(key);
    if (i === -1) selectedSites.push(key);
    else selectedSites.splice(i, 1);
    if (!selectedSites.length) selectedSites.push(key);
    renderAll();
    save();
  }

  /**
   * 平台卡片矩阵。
   * HTML 中已静态写死 6 张卡片，此处只做增量状态同步：
   * 勾选态、is-on（启用净化）、is-current（已加入配置）、计数文案。
   * 不重建 DOM —— 既避免闪烁，也保证静态预览可见。
   */
  function renderPlatformGrid() {
    var cards = $platformGrid.querySelectorAll('.platform');
    if (!cards.length) return;

    cards.forEach(function (card) {
      var key = card.dataset.site;
      var cfg = siteCfgOf(key);
      if (!cfg) return;

      var on = !!cfg.enabled;
      var selected = currentSites().indexOf(key) !== -1;
      var ruleCount = siteRules(key).length;
      var typeOn = 0;
      Object.keys(cfg.types || {}).forEach(function (id) {
        if (cfg.types[id].enabled) typeOn++;
      });

      // 类名：is-on = 启用净化；is-current = 加入配置
      card.classList.toggle('is-on', on);
      card.classList.toggle('is-current', selected);
      card.title = (siteDef(key) || {}).name + ' · 点击' + (selected ? '取消' : '加入') + '配置';

      // 复选框：选中配置
      var chk = card.querySelector('.platform__check input');
      if (chk) {
        chk.checked = selected;
        chk.title = selected ? '已加入配置' : '点击加入配置';
      }

      // 开关：启用净化
      var sw = card.querySelector('.platform__switch');
      if (sw) {
        sw.dataset.on = on ? '1' : '0';
        sw.title = on ? '点击关闭该平台的净化' : '点击开启该平台的净化';
      }

      // 计数文案
      var meta = card.querySelector('.platform__meta');
      if (meta) {
        meta.textContent = on ? (typeOn + ' / ' + ruleCount + ' 项已启用') : '未启用净化';
        meta.classList.toggle('is-off', !on);
      }
    });
  }

  /**
   * 渲染配置区标题。
   * 单选平台 → 显示平台名；多选 → 显示「N 个平台」。
   */
  function renderSiteSection() {
    var sites = currentSites();
    var cfgs = currentCfgs();
    if (!sites.length) {
      $siteName.textContent = '未选择平台';
      $siteMeta.textContent = '请在下方勾选平台';
      renderRules();
      renderPlatformGrid();
      return;
    }

    // 标题：单选显示平台名，多选显示数量
    if (sites.length === 1) {
      $siteName.textContent = siteDef(sites[0]).name;
    } else {
      $siteName.textContent = sites.length + ' 个平台';
    }

    // 统计：所有选中平台的启用项总数 / 类型总数
    var typeOn = 0, typeAll = 0;
    cfgs.forEach(function (c) {
      Object.keys(c.types || {}).forEach(function (id) {
        typeAll++;
        if (c.types[id].enabled) typeOn++;
      });
    });
    $siteMeta.textContent = sites.length === 1
      ? typeOn + ' / ' + typeAll + ' 项已启用 · ' + siteDef(sites[0]).hosts[0]
      : '共 ' + typeAll + ' 项，已启用 ' + typeOn + ' 项';

    renderRules();
    renderPlatformGrid();
  }

  /**
   * 渲染类型列表。
   * 多平台时取「类型 id」并集：只在任一选中平台存在的类型才会出现。
   * 复选框三态：全开 / 全关 / 部分开启（indeterminate）。
   */
  function renderRules() {
    $ruleList.innerHTML = '';
    var sites = currentSites();
    if (!sites.length) return;

    // 按类型 id 聚合，记录该类型出现在哪些选中平台
    var union = {};
    var order = [];
    sites.forEach(function (key) {
      siteRules(key).forEach(function (rule) {
        if (!union[rule.id]) {
          union[rule.id] = { rule: rule, keys: [] };
          order.push(rule.id);
        }
        union[rule.id].keys.push(key);
      });
    });

    order.forEach(function (typeId) {
      var item = union[typeId];
      var rule = item.rule;
      var holders = item.keys;

      // 计算复选框三态
      var onCount = 0;
      holders.forEach(function (k) {
        var t = (siteCfgOf(k) || {}).types || {};
        if (t[typeId] && t[typeId].enabled) onCount++;
      });
      var allOn = onCount === holders.length;
      var someOn = onCount > 0;

      var label = document.createElement('label');
      label.className = 'rule';
      if (holders.length < sites.length) label.classList.add('is-partial');
      if (onCount === 0) label.classList.add('is-off');

      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = allOn;
      input.indeterminate = someOn && !allOn;
      input.dataset.type = typeId;

      var main = document.createElement('div');
      main.className = 'rule__main';

      var name = document.createElement('div');
      name.className = 'rule__name';
      name.appendChild(document.createTextNode(rule.name));

      var risk = RISK_LABEL[rule.risk];
      if (risk) {
        var tag = document.createElement('span');
        tag.className = 'tag ' + risk.cls;
        tag.textContent = risk.text;
        name.appendChild(tag);
      }

      // 多平台时显示「N/M 平台已开启」与适用平台短名
      if (sites.length > 1) {
        var cnt = document.createElement('span');
        cnt.className = 'rule__count';
        cnt.textContent = onCount + '/' + holders.length;
        name.appendChild(cnt);

        var keys = document.createElement('div');
        keys.className = 'rule__keys';
        BADC.SITE_DEFS.forEach(function (d) {
          if (holders.indexOf(d.key) === -1) return;
          var k = document.createElement('span');
          k.className = 'rule__key';
          var t = (siteCfgOf(d.key) || {}).types || {};
          if (t[typeId] && t[typeId].enabled) k.classList.add('is-on');
          k.textContent = d.short;
          k.title = d.name;
          keys.appendChild(k);
        });
        main.appendChild(name);
        main.appendChild(keys);
      } else {
        main.appendChild(name);
      }

      var desc = document.createElement('div');
      desc.className = 'rule__desc';
      desc.textContent = rule.desc;

      var sel = document.createElement('div');
      sel.className = 'rule__sel';
      sel.textContent = summarizeSelectors(rule);

      main.appendChild(desc);
      main.appendChild(sel);

      // 整块移除子开关（同样按三态应用到持有该类型的平台）
      if (rule.wholeBlocks && rule.wholeBlocks.length) {
        var wbOn = 0;
        holders.forEach(function (k) {
          var t = (siteCfgOf(k) || {}).types || {};
          if (t[typeId] && t[typeId].wholeBlock) wbOn++;
        });
        var wbWrap = document.createElement('div');
        wbWrap.className = 'rule__sub';
        var wbLabel = document.createElement('label');
        var wbInput = document.createElement('input');
        wbInput.type = 'checkbox';
        wbInput.checked = wbOn === holders.length;
        wbInput.indeterminate = wbOn > 0 && wbOn < holders.length;
        wbInput.dataset.type = typeId;
        wbInput.dataset.field = 'wholeBlock';
        var wbText = document.createElement('span');
        wbText.textContent = '整块移除整个推荐区';
        wbLabel.appendChild(wbInput);
        wbLabel.appendChild(wbText);
        wbWrap.appendChild(wbLabel);
        main.appendChild(wbWrap);
      }

      label.appendChild(input);
      label.appendChild(main);
      $ruleList.appendChild(label);
    });
  }


  /** 提取规则的选择器摘要 */
  function summarizeSelectors(rule) {
    var parts = [];
    if (rule.containerSelectors && rule.containerSelectors.length) {
      parts.push(rule.containerSelectors.slice(0, 3).join(', '));
    }
    if (rule.badgeSelectors && rule.badgeSelectors.length) {
      parts.push(rule.badgeSelectors.slice(0, 2).join(', '));
    }
    if (rule.wholeBlocks && rule.wholeBlocks.length) {
      parts.push(rule.wholeBlocks.join(', '));
    }
    var s = parts.join('  |  ');
    if (rule.containerSelectors && rule.containerSelectors.length > 3) s += ' …';
    return s || '—';
  }

  /** 按索引取自定义规则 */
  function findRule(idx) {
    var i = parseInt(idx, 10);
    return (settings.customRules && settings.customRules[i]) || null;
  }

  /** 渲染自定义规则卡片列表 */
  function renderCustomRules() {
    $customList.innerHTML = '';
    var rules = settings.customRules || [];

    $customEmpty.classList.toggle('is-hidden', rules.length > 0);

    rules.forEach(function (rule, idx) {
      var card = document.createElement('div');
      card.className = 'rule-card';

      var top = document.createElement('div');
      top.className = 'rule-card__top';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'rule-card__input';
      input.value = rule.selector || '';
      input.dataset.idx = String(idx);
      input.placeholder = 'CSS 选择器，如 #content_left div.ad-banner';
      input.spellcheck = false;

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'rule-card__del';
      del.dataset.idx = String(idx);
      del.title = '删除这条规则';
      del.textContent = '×';

      top.appendChild(input);
      top.appendChild(del);

      var sites = document.createElement('div');
      sites.className = 'rule-card__sites';

      var label = document.createElement('span');
      label.className = 'rule-card__label';
      label.textContent = '适用平台';
      sites.appendChild(label);

      // 全平台快捷 chip
      var allOn = BADC.SITE_DEFS.every(function (d) {
        return rule.sites.indexOf(d.key) !== -1;
      });
      var allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'chip chip--all' + (allOn ? ' is-on' : '');
      allChip.dataset.idx = String(idx);
      allChip.textContent = '全部';
      allChip.title = '一键应用到所有平台';
      sites.appendChild(allChip);

      BADC.SITE_DEFS.forEach(function (d) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (rule.sites.indexOf(d.key) !== -1 ? ' is-on' : '');
        chip.dataset.idx = String(idx);
        chip.dataset.site = d.key;
        chip.textContent = d.short;
        chip.title = d.name + (d.enabledByDefault === false ? '（默认未启用平台）' : '');
        sites.appendChild(chip);
      });

      card.appendChild(top);
      card.appendChild(sites);
      $customList.appendChild(card);
    });

    updateCustomHint();
  }

  function updateCustomHint() {
    var rules = (settings.customRules || []).filter(function (r) {
      return r.selector && r.selector.trim();
    });
    var sites = {};
    rules.forEach(function (r) { (r.sites || []).forEach(function (k) { sites[k] = 1; }); });
    var n = Object.keys(sites).length;
    $customHint.textContent = rules.length
      ? rules.length + ' 条规则 · 覆盖 ' + n + ' 个平台'
      : '0 条规则';
    $customHint.style.color = rules.length ? '#059669' : '#9aa0a8';
  }

  /* ---------- 保存 ---------- */
  function save(silent) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      BADC.save(settings).then(function (saved) {
        settings = saved;
        renderPlatformGrid();
        if (!silent) showSaved('设置已保存并生效');
        broadcast();
      });
    }, 120);
  }

  function showSaved(text) {
    $saveBar.querySelector('.savebar__text').textContent = text || '设置已保存并生效';
    $saveBar.classList.add('is-show');
    setTimeout(function () {
      $saveBar.classList.remove('is-show');
    }, 1800);
  }

  /** 通知所有已打开的搜索页面立即重算 */
  function broadcast() {
    chrome.tabs.query({}, function (tabs) {
      tabs.forEach(function (tab) {
        if (!tab.url || !/^https?:/.test(tab.url)) return;
        if (!BADC.siteOfHost(hostOf(tab.url))) return;
        chrome.tabs.sendMessage(tab.id, { type: 'BADC_SETTINGS_CHANGED' }, function () {
          void chrome.runtime.lastError;
        });
      });
    });
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  /* ---------- 导入导出 ---------- */
  function exportConfig() {
    var payload = JSON.stringify(settings, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'search-ad-killer-settings.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showSaved('配置已导出');
  }

  function importConfig() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          settings = BADC.normalize(data);
          BADC.save(settings).then(function (saved) {
            settings = saved;
            renderAll();
            save();
            showSaved('配置已导入');
          });
        } catch (e) {
          alert('配置文件格式有误，无法导入。');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  init();
})();