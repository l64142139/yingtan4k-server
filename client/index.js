// 影探4K · 客户端单文件 JS 源（index.js）
// 自带 base64 / AES-128-CBC / HTTP，不依赖 node:crypto、fastify、任何外部模块。
// 引擎适配顺序：优先用壳子的 req()，其次 fetch。
//
// 2026-11-26 版逻辑：
//   1) CMS 站 http://cms.lyyytv.cn/api.php/app/（nav / index_video / video / search / video_detail）
//   2) lvdou+ 播放串用 CMS_KEY 前16位做 key、后16位做 iv 解 AES-128-CBC
//   3) 两条解析线：7 = 网页线路（腾讯/爱奇艺/芒果 → m3u8），8 = 4K 直链（换联通云/天翼云）
//      级联备援：网页 7→5→8，4K 8→6→7

var HOST = 'http://cms.lyyytv.cn';
var CMS_KEY = 'wP5bvxoc3yv7FoBQENFZuAF0EUYr4LTy';
var UA = 'okhttp/4.12.0';
var PARSE_API = 'http://fys.lyyytv.cn/api/index?appid=10001&videoUrl=';
var FALLBACK_WEB = [7, 5, 8];
var FALLBACK_4K = [8, 6, 7];
var ROUNDS = 3;
var PAGE_LIMIT = 20;
var FILTERS = { class: '类型', area: '地区', lang: '语言', year: '年份', letter: '字母', by: '排序', sort: '顺序' };
var HEADERS = { 'User-Agent': UA };
var PARSE_HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'identity' };

var text = function (v) { return v == null ? '' : String(v).replace(/^\s+|\s+$/g, ''); };
var listOf = function (v) { return Array.isArray(v) ? v : []; };
var pageOf = function (v) { var n = parseInt(v, 10); return n > 0 ? n : 1; };
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function objectOf(v) {
  if (v && typeof v === 'object' && !(v instanceof Array)) return v;
  try {
    var p = JSON.parse(v);
    return p && typeof p === 'object' && !(p instanceof Array) ? p : {};
  } catch (e) { return {}; }
}

// ---------- base64 ----------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64ToBytes(s) {
  s = text(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  var out = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '=') break;
    var v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

function bytesToStr(b) {
  var s = '', i, c;
  for (i = 0; i < b.length; i++) {
    c = b[i];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[++i] & 0x3f));
    else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((b[++i] & 0x3f) << 6) | (b[++i] & 0x3f));
    else i += 3;
  }
  return s;
}

// ---------- AES-128 解密（查表由 GF 生成，避免手抄 S 盒） ----------
function gfMul(a, b) {
  var p = 0;
  while (b) {
    if (b & 1) p ^= a;
    var hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

function gfPow(a, n) {
  var r = 1;
  while (n) { if (n & 1) r = gfMul(r, a); a = gfMul(a, a); n >>= 1; }
  return r;
}

var SBOX = (function () {
  var s = [];
  for (var i = 0; i < 256; i++) {
    var inv = i === 0 ? 0 : gfPow(i, 254);
    s[i] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
  }
  return s;
})();

function rotl8(x, n) { return ((x << n) | (x >> (8 - n))) & 0xff; }

var INV_SBOX = (function () {
  var s = [], i;
  for (i = 0; i < 256; i++) s[SBOX[i]] = i;
  return s;
})();

function expandKey(key) {
  var w = new Array(44), i, t0, t1, t2, t3, rcon = 1;
  for (i = 0; i < 4; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  for (i = 4; i < 44; i++) {
    t0 = w[i - 1][0]; t1 = w[i - 1][1]; t2 = w[i - 1][2]; t3 = w[i - 1][3];
    if (i % 4 === 0) {
      var tmp = t0;
      t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
      rcon = gfMul(rcon, 2);
    }
    w[i] = [w[i - 4][0] ^ t0, w[i - 4][1] ^ t1, w[i - 4][2] ^ t2, w[i - 4][3] ^ t3];
  }
  return w;
}

// 状态按标准布局 st[row][col]，其中 block[row + 4*col]
function addRoundKey(st, w, round) {
  for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) st[r][c] ^= w[round * 4 + c][r];
}

function invSubBytes(st) {
  for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) st[r][c] = INV_SBOX[st[r][c]];
}

// InvShiftRows：第 r 行右移 r 位
function invShiftRows(st) {
  var r, c, copy = [[], [], [], []];
  for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) copy[r][c] = st[r][c];
  for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) st[r][(c + r) % 4] = copy[r][c];
}

function invMixColumns(st) {
  for (var c = 0; c < 4; c++) {
    var a0 = st[0][c], a1 = st[1][c], a2 = st[2][c], a3 = st[3][c];
    st[0][c] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
    st[1][c] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
    st[2][c] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
    st[3][c] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
  }
}

function decryptBlock(block, w) {
  var st = [[], [], [], []], r, c;
  for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) st[r][c] = block[r + 4 * c];
  addRoundKey(st, w, 10);
  for (var round = 9; round > 0; round--) {
    invShiftRows(st); invSubBytes(st); addRoundKey(st, w, round); invMixColumns(st);
  }
  invShiftRows(st); invSubBytes(st); addRoundKey(st, w, 0);
  var out = new Array(16);
  for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) out[r + 4 * c] = st[r][c];
  return out;
}

function aesCbcDecrypt(keyBytes, ivBytes, dataBytes) {
  var w = expandKey(keyBytes);
  var prev = ivBytes.slice(0), plain = [], i;
  for (i = 0; i + 16 <= dataBytes.length; i += 16) {
    var block = dataBytes.slice(i, i + 16);
    var dec = decryptBlock(block, w);
    for (var j = 0; j < 16; j++) plain.push(dec[j] ^ prev[j]);
    prev = block;
  }
  // PKCS7 去填充
  var pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16 && plain.length >= pad) {
    var ok = true;
    for (i = plain.length - pad; i < plain.length; i++) if (plain[i] !== pad) { ok = false; break; }
    if (ok) plain = plain.slice(0, plain.length - pad);
  }
  return plain;
}

// ---------- HTTP ----------
function httpGet(url, headers) {
  var h = {}, k;
  for (k in (headers || {})) h[k] = headers[k];
  if (!h['User-Agent']) h['User-Agent'] = UA;

  return (async function () {
    var reqFn = typeof globalThis.req === 'function' ? globalThis.req : (typeof req === 'function' ? req : null);
    if (reqFn) {
      try {
        var r = await reqFn(url, { method: 'get', headers: h });
        var body = r && typeof r === 'object'
          ? (r.content !== undefined ? r.content : (r.data !== undefined ? r.data : JSON.stringify(r)))
          : r;
        var code = r && typeof r === 'object' && r.code !== undefined ? parseInt(r.code, 10) : 200;
        return { status: code || 200, body: text(body) };
      } catch (e) { /* 换 fetch */ }
    }
    if (typeof fetch === 'function') {
      var res = await fetch(url, { headers: h, method: 'GET' });
      var t = await res.text();
      return { status: res.status, body: text(t) };
    }
    throw new Error('影探4K：当前壳子未提供 req()/fetch，取不到网络数据');
  })();
}

// ---------- CMS ----------
async function getJson(url, headers) {
  var r = await httpGet(url, headers || HEADERS);
  var data = objectOf(r.body);
  if (!Object.keys(data).length) throw new Error('影探4K：接口未返回有效 JSON');
  return data;
}

async function cms(path, params) {
  var q = '', k = Object.keys(params || {});
  for (var i = 0; i < k.length; i++) {
    if (i) q += '&';
    q += encodeURIComponent(k[i]) + '=' + encodeURIComponent(params[k[i]]);
  }
  var data = await getJson(HOST + '/api.php/app/' + path + '?' + q);
  if (data.code != null && [1, 200].indexOf(Number(data.code)) < 0) throw new Error('影探4K：CMS 请求失败');
  return data;
}

function decryptLvdou(value) {
  var s = text(value);
  if (s.indexOf('lvdou+') !== 0) return s;
  try {
    var enc = b64ToBytes(s.slice(6));
    if (!enc.length) return s;
    var key = CMS_KEY.slice(0, 16);
    var iv = CMS_KEY.length >= 32 ? CMS_KEY.slice(16, 32) : key;
    var plain = aesCbcDecrypt(key.split('').map(function (c) { return c.charCodeAt(0); }),
                              iv.split('').map(function (c) { return c.charCodeAt(0); }), enc);
    var out = text(bytesToStr(plain));
    if (out.indexOf('http') === 0) return out;
  } catch (e) { /* fallthrough */ }
  return s;
}

// ---------- URL 判定 ----------
var MEDIA_RE = /\.(?:mp4|m3u8?|flv|avi|mkv|ts|mov|wmv|webm|m4v|mpd)$/i;
var STREAM_RE = /\.(?:m3u8?|mpd)$/i;
var HOST4K_RE = /(?:^|\.)(?:ym4kjx|hd4kjx|sd4kjx|mm4kjx|mv4kjx|vk4kjx)\.lyyytv\.cn$/i;

function isHttpUrl(u) { return /^https?:\/\//i.test(text(u)); }
function isMediaUrl(u) { return isHttpUrl(u) && MEDIA_RE.test(pathOf(u)); }
function isStreamUrl(u) { return isHttpUrl(u) && STREAM_RE.test(pathOf(u)); }

function pathOf(u) {
  var s = text(u).replace(/^[a-z]+:\/\/[^\/]*/i, '');
  var i = s.indexOf('?');
  return i < 0 ? s : s.slice(0, i);
}

function hostOf(u) {
  var m = text(u).match(/^[a-z]+:\/\/([^\/:?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function is4kSource(u) {
  if (!isHttpUrl(u)) return false;
  var h = hostOf(u);
  if (h && HOST4K_RE.test(h)) return true;
  return isMediaUrl(u) && !isStreamUrl(u);
}

// ---------- 解析 ----------
function findUrl(v) {
  if (!v || typeof v !== 'object') return '';
  var keys = ['url', 'playUrl', 'link'], i;
  for (i = 0; i < keys.length; i++) if (v[keys[i]]) return text(v[keys[i]]);
  return findUrl(v.data);
}

function resolveParse(body) {
  var candidate = text(body);
  if (!candidate) return '';
  if (candidate.charAt(0) === '{') {
    try {
      var found = findUrl(JSON.parse(candidate));
      if (found) candidate = found;
    } catch (e) { /* fallthrough */ }
  }
  // https://baidu.con/ 前缀：前 16 位 key=iv，余下 base64 密文
  if (candidate.indexOf('https://baidu.con/') === 0) {
    var rest = candidate.slice('https://baidu.con/'.length);
    if (rest.length <= 16) return '';
    var key = rest.slice(0, 16).split('').map(function (c) { return c.charCodeAt(0); });
    var enc = b64ToBytes(rest.slice(16));
    if (!enc.length) return '';
    try {
      var out = text(bytesToStr(aesCbcDecrypt(key, key, enc)));
      if (out.indexOf('http') === 0) return out;
    } catch (e) { /* fallthrough */ }
    return '';
  }
  return candidate;
}

async function parseRound(raw, pid) {
  var url = PARSE_API + encodeURIComponent(raw) + '&parsesId=' + pid;
  try {
    var r = await httpGet(url, PARSE_HEADERS);
    if (r.status !== 200 || !r.body) return '';
    if (r.body.slice(0, 2000).indexOf('System Error') >= 0) return '';
    var out = resolveParse(r.body);
    return out && out.indexOf('http') === 0 ? out : '';
  } catch (e) { return ''; }
}

async function parseUrl(raw, pid) {
  if (!raw) return '';
  for (var r = 0; r < ROUNDS; r++) {
    if (r) await sleep(r * 350);
    var out = await parseRound(raw, pid);
    if (out) return out;
  }
  return '';
}

async function parseCascade(raw, pids) {
  for (var i = 0; i < pids.length; i++) {
    var out = await parseUrl(raw, pids[i]);
    if (out) return out;
  }
  return '';
}

// ---------- 数据整形 ----------
function paginated(data, reqPage) {
  var list = listOf(data.list);
  var page = pageOf(data.page != null ? data.page : reqPage);
  var limit = Number(data.limit) > 0 ? Number(data.limit) : PAGE_LIMIT;
  var hasPc = Number(data.pagecount) > 0;
  var pagecount = hasPc ? Number(data.pagecount) : page + (list.length >= limit ? 1 : 0);
  var total = hasPc && Number(data.total) >= 0
    ? Number(data.total)
    : (page - 1) * limit + list.length + (pagecount > page ? 1 : 0);
  return { page: page, pagecount: pagecount, limit: limit, total: total, list: list };
}

function playlist(value) {
  var entries = text(value).split('#'), out = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i], sep = e.indexOf('$');
    if (sep <= 0 || !text(e.slice(sep + 1))) continue;
    out.push(text(e.slice(0, sep)) + '$' + decryptLvdou(e.slice(sep + 1)));
  }
  return out.join('#');
}

// ---------- 对外接口 ----------
async function home() {
  var data = await cms('nav', { token: '' });
  var classes = [], filters = {};
  for (var i = 0; i < listOf(data.list).length; i++) {
    var item = data.list[i];
    if (!item || item.type_id == null || !text(item.type_name)) continue;
    var id = String(item.type_id);
    classes.push({ type_id: id, type_name: text(item.type_name) });
    var ext = objectOf(item.type_extend), groups = [];
    for (var key in FILTERS) {
      if (!FILTERS.hasOwnProperty(key)) continue;
      var vals = text(ext[key]).split(','), uniq = [], j;
      for (j = 0; j < vals.length; j++) {
        var v = text(vals[j]);
        if (v && uniq.indexOf(v) < 0) uniq.push(v);
      }
      if (uniq.length) {
        var arr = [{ n: '全部', v: '' }];
        for (j = 0; j < uniq.length; j++) arr.push({ n: uniq[j], v: uniq[j] });
        groups.push({ key: key, name: FILTERS[key], init: '', value: arr });
      }
    }
    if (groups.length) filters[id] = groups;
  }
  return JSON.stringify({ class: classes, filters: filters });
}

async function homeVod() {
  var data = await cms('index_video', { token: '' });
  var list = [];
  for (var i = 0; i < listOf(data.list).length; i++) {
    var item = data.list[i];
    var vs = item && item.vlist ? listOf(item.vlist) : [];
    for (var j = 0; j < vs.length; j++) list.push(vs[j]);
  }
  return JSON.stringify({ list: list });
}

async function category() {
  var body = {};
  try {
    body = {
      id: typeof MY_CATE !== 'undefined' ? MY_CATE : '',
      page: typeof MY_PAGE !== 'undefined' ? MY_PAGE : 1,
      filters: typeof MY_EXTEND !== 'undefined' ? MY_EXTEND : {},
    };
  } catch (e) { /* 忽略 */ }
  var page = pageOf(body.page), id = text(body.id);
  if (!id) return JSON.stringify(paginated({ list: [] }, page));
  var params = { tid: id, pg: String(page), limit: '18' };
  var f = objectOf(body.filters);
  for (var key in FILTERS) {
    if (!FILTERS.hasOwnProperty(key)) continue;
    var v = text(f[key]);
    if (v && v !== 'all') params[key] = v;
  }
  return JSON.stringify(paginated(await cms('video', params), page));
}

async function detail() {
  var input;
  try { input = typeof MY_ID !== 'undefined' ? MY_ID : ''; } catch (e) { input = ''; }
  var ids = (input instanceof Array ? input : [input]).map(text).filter(Boolean);
  var list = [];
  for (var i = 0; i < ids.length; i++) {
    var data = (await cms('video_detail', { id: ids[i] })).data;
    if (!data || typeof data !== 'object' || data instanceof Array) continue;
    var players = data.vod_url_with_player;
    var names = text(data.vod_play_from).split('$$$');
    var sources = players instanceof Array
      ? players
      : text(data.vod_play_url).split('$$$').map(function (url, idx) { return { name: names[idx], url: url }; });
    var froms = [], urls = [];
    for (var k = 0; k < sources.length; k++) {
      var src = sources[k];
      if (!src || typeof src !== 'object') continue;
      var pu = playlist(src.url);
      if (!pu) continue;
      // 不做源站 404 滤线：4K 直链域名本体 404，靠 pid8 换链照样能播
      var nm = text(src.name) || text(src.code) || ('线路' + (k + 1));
      froms.push(nm.replace(/[$#]/g, ' '));
      urls.push(pu);
    }
    list.push({
      vod_id: data.vod_id, vod_name: data.vod_name, vod_pic: data.vod_pic,
      vod_content: data.vod_content, vod_remarks: data.vod_remarks,
      type_name: data.vod_class, vod_year: data.vod_year, vod_area: data.vod_area,
      vod_actor: data.vod_actor, vod_director: data.vod_director,
      vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$'),
    });
  }
  return JSON.stringify({ list: list });
}

async function play() {
  var raw;
  try { raw = typeof MY_URL !== 'undefined' ? MY_URL : ''; } catch (e) { raw = ''; }
  var original = decryptLvdou(raw);
  if (!original) return JSON.stringify({ parse: 0, url: '', header: PARSE_HEADERS });
  if (is4kSource(original)) {
    var r4 = await parseCascade(original, FALLBACK_4K);
    return JSON.stringify({ parse: 0, url: r4 || original, header: PARSE_HEADERS });
  }
  if (isStreamUrl(original)) {
    return JSON.stringify({ parse: 0, url: original, header: PARSE_HEADERS });
  }
  var rw = await parseCascade(original, FALLBACK_WEB);
  if (!rw && isMediaUrl(original)) rw = original;
  return JSON.stringify({ parse: 0, url: rw || '', header: PARSE_HEADERS });
}

async function search() {
  var wd;
  try { wd = typeof MY_KEYWORD !== 'undefined' ? MY_KEYWORD : (typeof MY_KEY !== 'undefined' ? MY_KEY : ''); } catch (e) { wd = ''; }
  var page = 1;
  try { page = typeof MY_PAGE !== 'undefined' ? pageOf(MY_PAGE) : 1; } catch (e) { page = 1; }
  wd = text(wd);
  if (!wd) return JSON.stringify(paginated({ list: [] }, page));
  var data = await cms('search', { text: wd, pg: String(page) });
  var list = [];
  for (var i = 0; i < listOf(data.list).length; i++) {
    var item = data.list[i] || {};
    var copy = {}, k;
    for (k in item) if (item.hasOwnProperty(k) && k !== 'type') copy[k] = item[k];
    list.push(copy);
  }
  return JSON.stringify(paginated({ page: data.page, pagecount: data.pagecount, limit: data.limit, total: data.total, list: list }, page));
}

// ---------- 挂到全局，兼容各种壳子的取用方式 ----------
globalThis.home = home;
globalThis.homeVod = homeVod;
globalThis.category = category;
globalThis.detail = detail;
globalThis.play = play;
globalThis.search = search;
globalThis.rule = { title: '影探4K', host: HOST, key: 'yingtan4k' };

try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = { home: home, homeVod: homeVod, category: category, detail: detail, play: play, search: search, rule: globalThis.rule };
    module.exports['default'] = module.exports;
  }
} catch (e) { /* 引擎无 module 时忽略 */ }
