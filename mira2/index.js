// 影探4K · MiraPlay / 猫爪 网页源包 v2
// 结构：globalThis.websiteBundle = function(){ return "<网页应用>" }
// 应用主体托管在 CDN，本文件负责拉取并注入页面。
var APP = 'https://aka.doubaocdn.com/s/zMUsLQjm7X';

globalThis.websiteBundle = function () {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<style>html,body{margin:0;background:#0b0d12;color:#8b96a8;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}#b{padding:48px 16px;text-align:center;line-height:1.8}</style>'
    + '</head><body><div id="b">影探4K 正在加载…</div><script>'
    + '(function(){var u="' + APP + '";'
    + 'fetch(u,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();})'
    + '.then(function(h){document.open();document.write(h);document.close();})'
    + '.catch(function(e){var d=document.getElementById("b");if(d)d.innerHTML="影探4K 加载失败<br><span style=\\"color:#666;font-size:12px\\">"+(e&&e.message?e.message:String(e))+"</span>";});'
    + '})();<\/script></body></html>';
};

globalThis.rule = { title: '影探4K', host: 'cms.lyyytv.cn', key: 'yingtan4k' };

try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = globalThis.websiteBundle;
    module.exports['default'] = globalThis.websiteBundle;
  }
} catch (e) {}
