/**
 * popup/popup.js
 * 弹窗交互逻辑：总开关、处理方式、当前站点的去除类型快捷勾选、统计展示。
 * 自动识别当前标签页所属站点，只显示该站点的规则。
 */

(function () {
  'use strict';

  var BADC = globalThis.BADC;
  var RULES = globalThis.BADC_RULES;

  var settings = null;
  var tabStats = { total: 0, byType: {} };
  /** 当前标签页所属站点；非支持站点为 null */
  var currentSite = null;

  var $master = document.getElementById('masterSwitch');
  var $siteTag = document.getElementById('siteTag');
  var $modeGroup = document.getElementById('modeGroup');
  var $typeList = document.getElementById('typeList');
  var $typeLabel = document.getElementById('typeLabel');
  var $statNum = document.getElementById('statNum');
  var $resetBtn = document.getElementById('resetBtn');
  var $reloadBtn = document.getElementById('reloadBtn');
  var $openOptions = document.getElementById('openOptions');
  var $pageStatus = document.getElementById('pageStatus');
  var $modeHint = document.getElementById('modeHint');

  var MODE_HINTS = {
    collapse: '广告被压缩为一条细提示，可随时点「展开」临时查看。推荐，最稳妥。',
    hide: '广告直接隐藏，不留痕迹。页面会瞬间变短，滚动位置可能有轻微跳动。',
    remove: '广告节点被彻底删除，页面最干净。若担心误伤，可在设置页逐类关闭。'
  };

  /* ---------- 初始化 ---------- */
  function init() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var url = tab ? (tab.url || '') : '';
      try {
        currentSite = BADC.siteOfHost(new URL(url).hostname);
      } catch (e) {
        currentSite = null;
      }

      BADC.load().then(function (cfg) {
        settings = cfg;
        render();
        loadStats();
        renderStatus();
      });
    });

    $master.addEventListener('change', function () {
      settings.enabled = $master.checked;
      persist();
    });

    $modeGroup.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg');
      if (!btn) return;
      settings.mode = btn.dataset.mode;
      persist();
    });

    $typeList.addEventListener('change', function (e) {
      var input = e.target.closest('input[type="checkbox"]');
      if (!input || !currentSite) return;
      var cfg = siteCfg();
      if (!cfg || !cfg.types || !cfg.types[input.dataset.type]) return;
      cfg.types[input.dataset.type].enabled = input.checked;
      persist();
    });

    $resetBtn.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'BADC_RESET' }, function () {
        tabStats = { total: 0, byType: {} };
        renderStats();
        renderTypes();
      });
    });

    $reloadBtn.addEventListener('click', function () {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) chrome.tabs.reload(tabs[0].id);
        window.close();
      });
    });

    $openOptions.addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  function siteCfg() {
    if (!currentSite || !settings.sites) return null;
    return settings.sites[currentSite];
  }

  function siteDef(key) {
    return BADC.SITE_DEFS.filter(function (s) { return s.key === key; })[0];
  }

  function persist() {
    BADC.save(settings).then(function (saved) {
      settings = saved;
      render();
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'BADC_SETTINGS_CHANGED' }, function () {
            void chrome.runtime.lastError;
          });
        }
      });
    });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    $master.checked = !!settings.enabled;

    var def = currentSite ? siteDef(currentSite) : null;
    $siteTag.textContent = def ? def.name : '未匹配站点';
    $siteTag.className = 'sitetag' + (def ? '' : ' sitetag--off');
    $typeLabel.textContent = def ? def.name + ' · 去除类型' : '去除类型';

    Array.prototype.forEach.call($modeGroup.querySelectorAll('.seg'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.mode === settings.mode);
    });
    $modeHint.textContent = MODE_HINTS[settings.mode] || '';

    renderTypes();
    renderStats();
  }

  function renderTypes() {
    $typeList.innerHTML = '';

    if (!currentSite) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '当前页面不是受支持的搜索站点';
      $typeList.appendChild(empty);
      return;
    }

    var cfg = siteCfg();
    var rules = RULES.forSite(currentSite);

    rules.forEach(function (rule) {
      var t = (cfg && cfg.types && cfg.types[rule.id]) || { enabled: true };
      var count = tabStats.byType[rule.id] || 0;

      var label = document.createElement('label');
      label.className = 'type';

      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!t.enabled;
      input.dataset.type = rule.id;

      var name = document.createElement('span');
      name.className = 'type__name';
      name.textContent = rule.name;
      name.title = rule.desc;

      var badge = document.createElement('span');
      badge.className = 'type__count' + (count > 0 ? '' : ' is-zero');
      badge.textContent = String(count);

      label.appendChild(input);
      label.appendChild(name);

      if (rule.risk === 'careful' || rule.risk === 'aggressive') {
        var risk = document.createElement('span');
        risk.className = 'type__risk type__risk--' + rule.risk;
        risk.textContent = rule.risk === 'aggressive' ? '激进' : '谨慎';
        risk.title = rule.desc;
        label.appendChild(risk);
      }

      label.appendChild(badge);
      $typeList.appendChild(label);
    });
  }

  function renderStats() {
    $statNum.textContent = String(tabStats.total || 0);
  }

  function loadStats() {
    chrome.runtime.sendMessage({ type: 'BADC_GET_STATS' }, function (res) {
      void chrome.runtime.lastError;
      if (res) {
        tabStats = { total: res.total || 0, byType: res.byType || {} };
        renderStats();
        renderTypes();
      }
    });
  }

  /* ---------- 当前页面状态 ---------- */
  function renderStatus() {
    if (!currentSite) {
      $pageStatus.textContent = '当前页面不在净化范围';
      $pageStatus.className = 'foot__status is-off';
      return;
    }
    var cfg = siteCfg();
    if (!settings.enabled) {
      $pageStatus.textContent = '净化已关闭';
      $pageStatus.className = 'foot__status is-off';
      return;
    }
    if (!cfg || !cfg.enabled) {
      $pageStatus.textContent = siteDef(currentSite).short + ' 净化已关闭';
      $pageStatus.className = 'foot__status is-off';
      return;
    }
    $pageStatus.textContent = '● 正在净化本页';
    $pageStatus.className = 'foot__status is-ok';
  }

  init();
})();