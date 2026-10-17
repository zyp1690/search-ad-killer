/**
 * background/service-worker.js
 * 职责：
 * 1. 统计当前标签页被过滤的广告数量，供 popup 展示
 * 2. 在扩展图标上显示角标
 * 3. 提供安装引导（首次安装自动打开设置页）
 */

var STATS_KEY = 'badcTabStats';

function getStats(tabId) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STATS_KEY, function (data) {
      var all = (data && data[STATS_KEY]) || {};
      resolve(all[String(tabId)] || { total: 0, byType: {} });
    });
  });
}

function setStats(tabId, stats) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STATS_KEY, function (data) {
      var all = (data && data[STATS_KEY]) || {};
      all[String(tabId)] = stats;
      chrome.storage.local.set({ [STATS_KEY]: all }, resolve);
    });
  });
}

function clearStats(tabId) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STATS_KEY, function (data) {
      var all = (data && data[STATS_KEY]) || {};
      delete all[String(tabId)];
      chrome.storage.local.set({ [STATS_KEY]: all }, resolve);
    });
  });
}

function updateBadge(tabId, total) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  var text = total > 0 ? (total > 999 ? '999+' : String(total)) : '';
  chrome.action.setBadgeText({ tabId: tabId, text: text });
  chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#dc2626' });
}

/* 内容脚本上报过滤结果 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  var tabId = sender.tab ? sender.tab.id : null;
  if (tabId === null) return;

  if (msg.type === 'BADC_REPORT') {
    getStats(tabId).then(function (prev) {
      var next = {
        total: (prev.total || 0) + (msg.delta || 0),
        byType: Object.assign({}, prev.byType, msg.byType || {}),
        ts: Date.now()
      };
      return setStats(tabId, next).then(function () {
        updateBadge(tabId, next.total);
        sendResponse({ ok: true, total: next.total });
      });
    });
    return true; // 异步响应
  }

  if (msg.type === 'BADC_RESET') {
    clearStats(tabId).then(function () {
      updateBadge(tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }
});

/* popup 查询当前标签页统计 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'BADC_GET_STATS') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { sendResponse({ total: 0, byType: {} }); return; }
      getStats(tab.id).then(function (s) {
        sendResponse(Object.assign({ tabId: tab.id, url: tab.url || '' }, s));
      });
    });
    return true;
  }
});

/* 标签页刷新时清空该页统计 */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status === 'loading') {
    clearStats(tabId);
    updateBadge(tabId, 0);
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  clearStats(tabId);
});

/* 首次安装引导 */
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
});