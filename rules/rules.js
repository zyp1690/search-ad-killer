/**
 * rules/rules.js
 * 去除规则库（按站点分组）。内容脚本、设置页共用同一份定义，保证 UI 与实际行为一致。
 *
 * 支持站点：百度 / 360 搜索 / 搜狗搜索 / 必应 / Google / DuckDuckGo
 *
 * 跨引擎选择器主要依据 AdCleaner 规格书 8.3 节
 * （来源 EasyList China / AdGuard Chinese，规格标注"已核对"）。
 *
 * 规则字段说明：
 *   id             去除类型 id（站点内唯一）
 *   name           中文名
 *   desc           说明（设置页展示）
 *   risk           safe | careful | aggressive，设置页用于风险提示
 *   badgeSelectors 广告角标/标记元素（需向上回溯到所属卡片）
 *   containerSelectors 广告容器本身（命中即广告整块）
 *   badgeTexts     角标文案兜底（类名不稳定时使用）
 *   linkHints      推广链接特征（可用 :has()）
 *   wholeBlocks    可整块移除的大区域（需用户显式开启附属开关）
 *   ancestor       祖先卡片选择器；非 null 时命中元素会向上回溯到该卡片
 *   maxUp          最多向上查找层级
 *   selfOnly       true 表示容器选择器已精确指向广告本身，不再向上回溯
 *   defaultEnabled 默认是否开启
 */
(function () {
  'use strict';

  /* ============================================================
   * 百度搜索
   * ========================================================== */

  /** 百度搜索结果卡片容器（推广条目通常包在最外层卡片里） */
  var BAIDU_CARD = '.c-container, .result, .result-op, [tpl], [card-show-log], div[class*="aladdin"]';

  var BAIDU_RULES = [
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '搜索结果列表中带「广告」角标（ec-tuiguang / 商业推广标记）的推广结果。这是百度最主要、最显眼的广告来源。',
      risk: 'safe',
      badgeSelectors: [
        '.ec-tuiguang',
        '.ecfc-tuiguang',
        '.ec_tuiguang',
        'span[data-tuiguang]',
        '[data-tuiguang]',
        '.c-ad-info',
        '.ec-ad-inner'
      ],
      containerSelectors: [
        '.ec_ad_results',
        '[class*="EC_result"]',
        '.ecom-result',
        '.ec-abstract',
        '.ec-ad-container',
        '.cos-pc-ad-container',
        '.c-result-ad',
        '[data-module="ad"]',
        '.ec_wise_ad',
        '.ec-ad',
        '.tuiguang'
      ],
      badgeTexts: ['广告', '商业推广', '推广'],
      linkHints: [
        'a[href*="baidu.com/link?url="][data-tuiguang]',
        'a.ec-tuiguang-link'
      ],
      ancestor: BAIDU_CARD,
      maxUp: 6
    },
    {
      id: 'brandTop',
      name: '顶部品牌广告',
      desc: '搜索框下方或结果区顶部的品牌专区、官方推广横幅、logo 广告位。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '#top-ad',
        '.ec-ad-top',
        '#s-top-left .ec_tuiguang',
        '#s_banner',
        '.s-banner-ad',
        'div[id^="ec_tuiguang"]',
        '.ec-top-ad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'sidebar',
      name: '右侧推广栏',
      desc: '搜索结果右侧的「大家都在搜」「百度热搜」推荐区与其中的推广位。可只删推广卡片，或整块清空。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '#content_right .ec_ad_results',
        '#content_right [class*="EC_result"]',
        '#content_right .ecom-result',
        '#content_right .ec-ad',
        '#content_right [data-module="ad"]',
        '.ec-ad-container',
        '.cos-pc-ad-container'
      ],
      wholeBlocks: ['#content_right'],
      badgeTexts: [],
      linkHints: [],
      ancestor: BAIDU_CARD,
      maxUp: 6,
      /** 容器选择器均已带 #content_right 作用域，命中即广告本身，不回溯 */
      selfOnly: true
    },
    {
      id: 'banner',
      name: '横幅与图文推广位',
      desc: '页面中部、底部穿插的图片广告位、通栏图文推荐。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        'div[id^="ec_im_container"]',
        'div[class*="c-ads"]',
        'iframe[src*="bdimg.share.baidu.com"]',
        '.ec-im-container',
        '.c-ads',
        '.s-side-hover .ec_ad',
        '.ec-im'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'shopping',
      name: '电商 / 商品推广',
      desc: '带价格、店铺、商品信息的电商类推广（爱采购、商品聚合卡片）。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '[data-is-commerce]',
        '.ec-commerce',
        '.ec-pc-goods',
        '[tpl*="goods"]',
        '.ec-shop-card',
        '.ecom-goods'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: BAIDU_CARD,
      maxUp: 5
    },
    {
      id: 'nativeAds',
      name: '原生广告位',
      desc: '百度原生推广卡片（图文混排、带「广告」标记的原生内容流）。',
      risk: 'careful',
      badgeSelectors: ['.native-ad-badge', '.ec-native-badge'],
      containerSelectors: ['.native-ad', '.native_ad', '[data-native-ad]', '.ec-native'],
      badgeTexts: ['广告'],
      linkHints: [],
      ancestor: BAIDU_CARD,
      maxUp: 5
    },
    {
      id: 'aggregated',
      name: '聚合页与榜单推荐',
      desc: '搜索结果中的专题聚合卡、榜单模块、带推广性质的推荐内容块。',
      risk: 'aggressive',
      badgeSelectors: [],
      containerSelectors: ['.ec-agregate', '.ec-topsummary .ec_ad', '[data-aggregate-ad]', '.ec-theme-ads'],
      badgeTexts: [],
      linkHints: [],
      ancestor: BAIDU_CARD,
      maxUp: 4
    },
    {
      id: 'baitiao',
      name: '百度动态信息流',
      desc: '「百度动态」区域中的推广信息流条目。',
      risk: 'careful',
      badgeSelectors: ['.ec-baitiao-ad'],
      containerSelectors: ['#baitiao .ec_ad_results', '.baitiao-ad', '.ec-baitiao-ad-container'],
      badgeTexts: ['推广'],
      linkHints: [],
      ancestor: BAIDU_CARD,
      maxUp: 5
    },
    {
      id: 'floating',
      name: '悬浮窗与弹窗广告',
      desc: '页面右下角浮窗广告、客服弹窗式推广、底部吸条推广。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '#ec_ec_pplink',
        '.ec-tuiguang-pplink',
        '.ec-pplink',
        'div[class*="float-ad"]',
        '.ec-float-ad',
        '#ec-ad-float'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'aiAnswer',
      name: 'AI 智能答案区',
      desc: '百度 AI 摘要、智能问答模块。此类内容常夹带推广链接，默认关闭以免误伤正文。',
      risk: 'aggressive',
      badgeSelectors: [],
      containerSelectors: ['div[data-type="op-ai-summary"]', '.ec-ai-answer', '#bcs .ec_ad_results'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    },
    {
      id: 'relatedSearch',
      name: '相关搜索推广',
      desc: '结果页底部「相关搜索」中的推广词条。',
      risk: 'careful',
      badgeSelectors: ['#rs .ec-tuiguang', '#rs [data-tuiguang]'],
      containerSelectors: ['#rs .ec_ad_results', '#rs [class*="EC_result"]'],
      badgeTexts: ['广告'],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    },
    {
      id: 'iframe',
      name: '广告 iframe',
      desc: '以 iframe 形式加载的广告容器。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: ['iframe[id^="ec_"]', 'iframe[src*="ad"]', '.iframe-ad', '.ec_iframe'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    }
  ];

  /* ============================================================
   * 360 搜索
   * 选择器依据公开维护的 360 去广告脚本规则，并结合 360 广告产品线
   * （品牌臻选 / 凤舞 / 一站到底 / 商业推广）补充。
   * ========================================================== */

  /** 360 搜索结果条目容器 */
  var SO_CARD = '.res-list, li.res-list, .result, .res-list .res-list, #main .res-list';

  var SO360_RULES = [
    {
      id: 'brand',
      name: '品牌广告区',
      desc: '「品牌臻选」等品牌广告区块（#so_bd-ad）。360 搜索顶部最显眼的商业推广位。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '#so_bd-ad',
        '.so_bd-ad',
        '#so-brand-ad',
        '.brand-ad',
        '.ec-brand-ad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '结果列表中的条目广告（.e-buss 商业推广标记）与文字广告条目。',
      risk: 'safe',
      badgeSelectors: [
        '.e-buss',
        '.res-list .e-buss',
        'span.ad-icon',
        '.ad-icon',
        '.res-linkinfo .e-buss'
      ],
      containerSelectors: [
        '.e-buss-item',
        'li[data-e-buss]',
        '.res-list.ad',
        '.res-mediav',
        '.res-mediav-right'
      ],
      badgeTexts: ['广告', '推广', '商业推广'],
      linkHints: ['a[href*="so.com/link?m="][data-e-buss]'],
      ancestor: SO_CARD,
      maxUp: 4
    },
    {
      id: 'businessText',
      name: '商业推广文字广告',
      desc: '带 --normal 标识的商业文字推广条目，以及 business 相关推广模块（含魔盒游戏推广）。',
      risk: 'careful',
      badgeSelectors: ['[class*="business"] .ad-tag'],
      containerSelectors: [
        'div[id*="--normal"]',
        '.business',
        '[class*="business"]',
        '#mohe-webgame',
        '.mh-sdk-sad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: SO_CARD,
      maxUp: 4
    },
    {
      id: 'sidebar',
      name: '右侧推广栏',
      desc: '右侧栏广告与「猜你想搜」推荐位。可只删广告，或整块清空。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '#so_bd-ads',
        '.so-side-ad',
        '#aside .ad',
        '#lm-rightbottom',
        '.lm-rightbottom'
      ],
      wholeBlocks: ['#lm-rightbottom', '#so_bd-ads'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      selfOnly: true
    },
    {
      id: 'banner',
      name: '横幅与图文推广位',
      desc: '页面中部、底部穿插的图片广告位与通栏图文推荐。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '#so_banner',
        '.so-banner-ad',
        '.banner-ad',
        '.img-ad',
        'div[id^="so_ad"]'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'floating',
      name: '悬浮窗与遮罩广告',
      desc: '右下角浮窗、底部遮罩大图、相关消息广告等干扰性推广。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '.lawnfooter-image__panel',
        '.lawnfooter-ad',
        '.sad',
        '.so-float-ad',
        '.pop-ad',
        '.so-popup-ad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'aggregated',
      name: '聚合页与推荐位',
      desc: '聚合卡片、专题推荐与「大家都在搜」等推荐模块中夹带的推广。',
      risk: 'aggressive',
      badgeSelectors: [],
      containerSelectors: [
        '.res-rich .e-buss',
        '.aggregation .ad',
        '.so-aggregation-ad',
        '#so_related .ad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: SO_CARD,
      maxUp: 4,
      defaultEnabled: false
    },
    {
      id: 'iframe',
      name: '广告 iframe',
      desc: '以 iframe 形式加载的广告容器。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: ['iframe[id^="so_ad"]', 'iframe[src*="ad.so.com"]', '.iframe-ad'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    }
  ];

  /* ============================================================
   * 搜狗搜索
   * 选择器依据 AdCleaner 规格书 8.3 节（来源 EasyList China / AdGuard Chinese，已核对），
   * 其中 .ad_result / .ad-results 为实测新增发现。
   * ========================================================== */

  /** 搜狗结果条目容器 */
  var SOGOU_CARD = '.vrwrap, .rb, .results > div, .vrResult';

  var SOGOU_RULES = [
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '结果卡片内嵌的推广块（.ad_result / .ad-results）。这类推广嵌在结果条目内部，需向上清理整条结果。',
      risk: 'safe',
      badgeSelectors: ['.ad-badge', '.tuiguang-tag', '.sogou-ad-tag'],
      containerSelectors: [
        '.ad_result',
        '.ad-results',
        'div[id^="ad_result_page1_"]',
        '.tgad-box'
      ],
      badgeTexts: ['广告', '推广'],
      linkHints: [],
      ancestor: SOGOU_CARD,
      maxUp: 4,
      /** 内嵌型：需回溯到 .vrwrap 结果卡片 */
      selfOnly: false
    },
    {
      id: 'standaloneAd',
      name: '独立广告块',
      desc: '不依附结果条目的独立广告块（.js-ad-item 等），直接移除即可，无需回溯。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '.js-ad-item',
        '.ad-block-standalone',
        'div[id^="sogou_ad_"]'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      selfOnly: true
    },
    {
      id: 'brandTop',
      name: '顶部品牌广告',
      desc: '搜索框下方的品牌专区与推广横幅。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '.sogou-brand-ad',
        '#brand-ad',
        'div[id^="brand_ad"]',
        '.tgad-box-top'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'sidebar',
      name: '右侧推广栏',
      desc: '右栏推广位与「猜你喜欢」推荐模块中的广告。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '#PZL .ad',
        '#PZR .ad',
        '.right-ad',
        '.ad-side'
      ],
      wholeBlocks: ['#PZL', '#PZR'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      selfOnly: true
    },
    {
      id: 'banner',
      name: '横幅与图文推广位',
      desc: '页面中部、底部的图片广告与通栏图文推荐。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '.pop-tuiguang',
        '.sogou-img-ad',
        '.img-ad-box',
        'div[id^="ad_img_"]'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'floating',
      name: '悬浮窗与弹窗广告',
      desc: '右下角浮窗、遮罩弹窗式推广。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '.sogou-float-ad',
        '.pop-ad',
        '.float-ad-layer',
        '#sogou_float_ad'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'aggregated',
      name: '聚合与专题推荐',
      desc: '聚合卡片、专题推荐中夹带的推广内容。',
      risk: 'aggressive',
      badgeSelectors: [],
      containerSelectors: [
        '.ad-aggregate',
        '.special-ad',
        '.vrwrap .tgad-box'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    }
  ];

  /* ============================================================
   * 必应 Bing
   * 选择器依据 AdCleaner 规格书 8.3 节（已核对）。
   * ========================================================== */

  /** 必应结果条目容器 */
  var BING_CARD = '#b_results > li.b_algo, #b_results > li';

  var BING_RULES = [
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '结果列表中的赞助条目（.b_ad）以及跳转至 aclk 付费链接的结果。',
      risk: 'safe',
      badgeSelectors: ['.b_adlabel', '.sb_adlabel'],
      containerSelectors: [
        '.b_ad',
        '.sb_ad',
        '.mmaAdCard',
        '.b_bza_pole'
      ],
      badgeTexts: ['广告', 'Ad', 'Sponsored'],
      linkHints: [
        'li.b_algo:has(a[href^="https://www.bing.com/aclk?"])',
        'li:has(a[href^="https://www.bing.com/aclk?"])'
      ],
      ancestor: BING_CARD,
      maxUp: 3,
      selfOnly: true
    },
    {
      id: 'sidebar',
      name: '右侧推广栏',
      desc: '右栏广告卡与侧边赞助位（.pa_sb）。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '.pa_sb',
        '.b_adRightRail',
        '#b_context .b_ad',
        '.b_adTop'
      ],
      wholeBlocks: [],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      selfOnly: true
    },
    {
      id: 'banner',
      name: '横幅与图文推广位',
      desc: '顶部广告分隔条、图文推广位。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: [
        '.top-ads-separator-enabled',
        '.b_adBanner',
        '#b_banner'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'shopping',
      name: '商品与购物推广',
      desc: '必应购物广告卡（商品聚合位）。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '.b_adShopping',
        '.b_pole',
        '#b_results .b_adSl'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: BING_CARD,
      maxUp: 3,
      defaultEnabled: false
    }
  ];

  /* ============================================================
   * Google
   * 选择器依据 AdCleaner 规格书 8.3 节（已核对）。
   * 默认关闭：广告判定部分依赖英文文案，国内语料下误判风险更高。
   * ========================================================== */

  /** Google 结果条目容器 */
  var GOOGLE_CARD = '#search div.g, #rso div.g, #main div.g';

  var GOOGLE_RULES = [
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '标注「赞助 / Sponsored」的结果条目，以及 uEierd 广告容器。',
      risk: 'safe',
      badgeSelectors: ['.uEierd', '.commercial-unit-desktop-rhs'],
      containerSelectors: [
        '.uEierd',
        '.cu-container',
        'div[data-text-ad]',
        'div[data-is-ad="1"]',
        '.OcdnDb',
        '.commercial-unit-desktop-rhs'
      ],
      badgeTexts: ['广告', '赞助', 'Sponsored', 'Ad'],
      linkHints: ['a[href^="/aclk?sa="]', 'a[href*="googleadservices.com"]'],
      ancestor: GOOGLE_CARD,
      maxUp: 4,
      selfOnly: true
    },
    {
      id: 'topAds',
      name: '顶部广告条',
      desc: '搜索结果顶部的广告栏（#tads / #tadsb）。',
      risk: 'safe',
      badgeSelectors: [],
      containerSelectors: [
        '#tads',
        '#tadsb',
        '.commercial-unit-desktop-top-banner'
      ],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      selfOnly: true
    },
    {
      id: 'shopping',
      name: '商品与购物推广',
      desc: 'Google Shopping 商品广告位。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: ['.pla-unit', '.commercial-unit-desktop-rhs .cu-container'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    },
    {
      id: 'aggregated',
      name: '知识与聚合模块',
      desc: '知识图谱、聚合答案卡中的赞助内容。边界较模糊，默认关闭。',
      risk: 'aggressive',
      badgeSelectors: [],
      containerSelectors: ['.kp-header ~ .uEierd', '#bres .ad'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0,
      defaultEnabled: false
    }
  ];

  /* ============================================================
   * DuckDuckGo
   * 选择器依据 AdCleaner 规格书 8.3 节（已核对）。
   * 默认关闭：国内访问稳定性因网络环境而异。
   * ========================================================== */

  /** DDG 结果条目容器 */
  var DDG_CARD = '.result, article[data-testid="result"]';

  var DDG_RULES = [
    {
      id: 'inline',
      name: '结果内推广条目',
      desc: '标注「广告 / Ad」的赞助结果（.result--ad）与 y.js 跳转链接。',
      risk: 'safe',
      badgeSelectors: ['.result__badge-wrap', 'button.badge--ad'],
      containerSelectors: [
        '.result--ad',
        'tr.result-sponsored',
        'article[data-testid="result"][data-ad="1"]'
      ],
      badgeTexts: ['广告', 'Ad', 'Sponsored'],
      linkHints: ['a[href*="duckduckgo.com/y.js?"]'],
      ancestor: DDG_CARD,
      maxUp: 3,
      selfOnly: true
    },
    {
      id: 'banner',
      name: '横幅与推广位',
      desc: '页面横幅推广与空结果页的推广模块。',
      risk: 'careful',
      badgeSelectors: [],
      containerSelectors: ['.banner--ad', '.results--ad', '#links .result--ad'],
      badgeTexts: [],
      linkHints: [],
      ancestor: null,
      maxUp: 0
    }
  ];

  /* ============================================================
   * 注册表
   * ========================================================== */

  var SITES = {
    baidu: {
      key: 'baidu',
      name: '百度搜索',
      short: '百度',
      rules: BAIDU_RULES,
      /** 页面主容器，用于空白清理与保护 */
      mainContainers: ['#content_left', '#content_right']
    },
    so360: {
      key: 'so360',
      name: '360 搜索',
      short: '360',
      rules: SO360_RULES,
      mainContainers: ['#main', '#results', '#wrapper']
    },
    sogou: {
      key: 'sogou',
      name: '搜狗搜索',
      short: '搜狗',
      rules: SOGOU_RULES,
      mainContainers: ['#main', '.results', '#wrapper']
    },
    bing: {
      key: 'bing',
      name: '必应',
      short: '必应',
      rules: BING_RULES,
      mainContainers: ['#b_content', '#b_results', '#b_context']
    },
    google: {
      key: 'google',
      name: 'Google',
      short: 'Google',
      rules: GOOGLE_RULES,
      mainContainers: ['#search', '#rso', '#main', '#center_col']
    },
    ddg: {
      key: 'ddg',
      name: 'DuckDuckGo',
      short: 'DDG',
      rules: DDG_RULES,
      mainContainers: ['#react-layout', '#links', '#main-content']
    }
  };

  // 为每个规则预计算 id 索引，便于快速查找
  Object.keys(SITES).forEach(function (siteKey) {
    var idx = {};
    SITES[siteKey].rules.forEach(function (r) { idx[r.id] = r; });
    SITES[siteKey].byId = function (id) { return idx[id]; };
    SITES[siteKey].typeIds = SITES[siteKey].rules.map(function (r) { return r.id; });
  });

  globalThis.BADC_RULES = {
    SITES: SITES,
    siteKeys: Object.keys(SITES),
    /** 取某站点的规则集；未知站点返回空数组 */
    forSite: function (siteKey) {
      var s = SITES[siteKey];
      return s ? s.rules : [];
    },
    /** 取某站点某条规则 */
    rule: function (siteKey, ruleId) {
      var s = SITES[siteKey];
      return s && s.byId ? s.byId(ruleId) : null;
    },
    /** 兼容旧调用：返回百度规则集 */
    byId: function (id) {
      return this.rule('baidu', id);
    }
  };
})();