// 影探4K：由 影探4K.py（2026-11-26 版）移植为 JS。
// 相对 2026-10-31 版的改动：
//   1) 解析接口改回 fys.lyyytv.cn/api/index?appid=10001&videoUrl=…&parsesId=N
//   2) 拆两条解析线路：7 = 网页线路（腾讯/爱奇艺/芒果… → m3u8），8 = 4K 直链（换联通云盘/天翼云）
//      各自带级联备援：网页 7→5→8，4K 8→6→7
//   3) 去掉详情页的源站健康检查过滤：4K 域名 404 现在靠 pid8 换链救回来，提前隐藏反而误杀线路
//   4) 解析重试改 3 轮、退避 0.35s 递增
//   5) FILTER_NAMES 收回到 nav 实际给出的 7 个筛选项
import { createDecipheriv } from 'node:crypto';
import req from '../../util/req.js';
import { getHomeCache, setHomeCache, buildHomeCacheKey, HOME_CACHE_TTL } from '../../util/home-cache.js';

const KEY = 'yingtan4k';
const HOST = 'http://cms.lyyytv.cn';
const CMS_KEY = 'wP5bvxoc3yv7FoBQENFZuAF0EUYr4LTy';

// 解析接口（fys.lyyytv.cn 放映室）
// 2026-11 实测：老的 parsesId=3 记录已删除，接口直接 500
// 2026-11-26 复测：5/6 两条也死了（一律 {"code":0,"msg":"解析失败"}），全量扫描 pid1~12 后确认新的活口：
//   7 = 网页线路（腾讯/爱奇艺/芒果/优酷/B站 等页面地址 → m3u8）
//   8 = 4K 直链（ym4kjx.lyyytv.cn 下的 mp4/mkv，源站本体已 404，
//       靠它换成联通云盘 tjdownload.pan.wo.cn / 天翼云 cloudcube.telecomjs.com 直链）
// 4K 兄弟子域（hd4kjx/sd4kjx/mm4kjx/mv4kjx/vk4kjx）全部 403，直连无门。
// 服务商隔段时间就换 pid（3→5/6→7/8），备援级联按序降级试。
const PARSE_API = 'http://fys.lyyytv.cn/api/index?appid=10001&videoUrl=';
const PARSE_ID_WEB = 7;
const PARSE_ID_4K = 8;
// 级联备援：主 pid 失败后依次降级（失败响应很快，代价小）
const PARSE_FALLBACK_WEB = [7, 5, 8];
const PARSE_FALLBACK_4K = [8, 6, 7];
const HEADERS = { 'User-Agent': 'okhttp/4.12.0' };
// 解析请求/回源头：对齐 PARSE_HEADERS，避免 gzip 花屏
const PARSE_HEADERS = { 'User-Agent': 'okhttp/4.12.0', 'Accept-Encoding': 'identity' };

// baidu.con 前缀加密常量
const DEC_PREFIX = 'https://baidu.con/';
// 解析重试轮数与退避基数（秒）
const PARSE_ROUNDS = 3;
const PARSE_BACKOFF = 0.35;
// 同一原始地址解析结果缓存窗口（秒）
const PLAY_CACHE_TTL = 120;

// CMS 实测忽略 limit=18，固定每页 20 条；优先使用响应里的分页信息。
const PAGE_LIMIT = 20;
const FILTER_NAMES = {
  class: '类型', area: '地区', lang: '语言', year: '年份',
  letter: '字母', by: '排序', sort: '顺序',
};

// 内存缓存
const playCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => String(value ?? '').trim();
const pageOf = (value) => Math.max(1, Number.parseInt(value, 10) || 1);
const listOf = (value) => Array.isArray(value) ? value : [];

function objectOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function getJson(url, headers = HEADERS, timeout = 15000) {
  const response = await req.get(url, { headers, timeout, maxRedirects: 5, maxContentLength: 2 * 1024 * 1024 });
  const data = objectOf(response.data);
  if (!Object.keys(data).length) throw new Error('影探4K：接口未返回有效 JSON');
  return data;
}

async function cms(path, params = {}) {
  const query = new URLSearchParams(params);
  const data = await getJson(`${HOST}/api.php/app/${path}?${query}`);
  if (data.code != null && ![1, 200].includes(Number(data.code))) {
    throw new Error('影探4K：CMS 请求失败');
  }
  return data;
}

function decodeBase64(value) {
  const clean = text(value).replace(/\s+/g, '');
  // Buffer.from(..., 'base64') 本身会忽略非法字符，必须先检查，避免误解码明文 URL。
  if (!clean || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

// 对齐 decUrlOne：lvdou+ → 前 16 位 key / 后 16 位 iv 的 AES-128-CBC/PKCS7
function decryptLvdou(value) {
  const original = text(value);
  if (!original.startsWith('lvdou+')) return original;
  if (!CMS_KEY) return original;
  try {
    const encrypted = decodeBase64(original.slice(6));
    if (!encrypted?.length) return original;
    const key = Buffer.from(CMS_KEY.slice(0, 16), 'utf8');
    const iv = CMS_KEY.length >= 32 ? Buffer.from(CMS_KEY.slice(16, 32), 'utf8') : key;
    const cipher = createDecipheriv('aes-128-cbc', key, iv);
    const result = Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8').trim();
    if (result.startsWith('http')) return result;
  } catch { /* fallthrough */ }
  return original;
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function isLdmaxUrl(value) {
  return /^https?:\/\/ldmax\.cooom\//i.test(value);
}

// 兼容老加密：ldmax.cooom 前缀
function decryptLdmax(value, depth = 0) {
  if (depth > 5) return '';
  let url = text(value);
  const decoded = decodeBase64(url);
  if (decoded) url = decoded.toString('utf8').replace(/\s+/g, '');
  if (!isLdmaxUrl(url)) return url;
  // 不使用 URL.pathname：密文中的 +、/、= 必须原样保留。
  const path = url.replace(/^https?:\/\/ldmax\.cooom\//i, '');
  if (path.length <= 16) return '';
  try {
    const key = Buffer.from(path.slice(0, 16).split('').reverse().join(''), 'utf8');
    const encrypted = decodeBase64(path.slice(16));
    if (!encrypted?.length || encrypted.length % 16) return '';
    const cipher = createDecipheriv('aes-128-cbc', key, key);
    // 兼容原脚本的 padding 处理，包括未填充的整块密文。
    cipher.setAutoPadding(false);
    let plain = Buffer.concat([cipher.update(encrypted), cipher.final()]);
    const pad = plain[plain.length - 1];
    if (pad > 0 && pad <= 16) plain = plain.subarray(0, -pad);
    const result = plain.toString('utf8').trim();
    return isLdmaxUrl(result) ? decryptLdmax(result, depth + 1) : result;
  } catch { return ''; }
}

const MEDIA_RE = /\.(?:mp4|m3u8?|flv|avi|mkv|ts|mov|wmv|webm|m4v|mpd)$/i;
// HLS/DASH 直链：本身就能播，不需要走解析
const STREAM_RE = /\.(?:m3u8?|mpd)$/i;
// 4K 片源主机（ym4kjx 是主站，其余子域为历史/备用）
const HOST4K_RE = /(?:^|\.)(?:ym4kjx|hd4kjx|sd4kjx|mm4kjx|mv4kjx|vk4kjx)\.lyyytv\.cn$/i;

function isMediaUrl(url) {
  if (!isHttpUrl(url)) return false;
  try { return MEDIA_RE.test(new URL(url).pathname); } catch { return false; }
}

// 已经是 m3u8/mpd 的直链，播放器能直接拉，无需解析。
function isStreamUrl(url) {
  if (!isHttpUrl(url)) return false;
  try { return STREAM_RE.test(new URL(url).pathname); } catch { return false; }
}

// 4K 线路：ym4kjx 下的 mp4/mkv 直链（站点本身 404，要走 parsesId=8 换链）。
function is4kSource(url) {
  if (!isHttpUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host && HOST4K_RE.test(host)) return true;
  } catch { return false; }
  // 主机名变了也能认：非 HLS 的直链媒体文件一律当 4K 片源
  return isMediaUrl(url) && !isStreamUrl(url);
}

// 对齐 findUrl：从解析响应 JSON 中挑出 url/playUrl/link/data.url
function findUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['url', 'playUrl', 'link']) {
    if (value[key]) return text(value[key]);
  }
  return findUrl(value.data);
}

// 对齐 resolveParse：
//   1) JSON 包裹 → 取出 url
//   2) https://baidu.con/ 前缀 → 前 16 位 key=iv，余下 base64 密文 AES-128-CBC/PKCS7
//   3) 明文 URL
function resolveParse(body) {
  let candidate = text(body);
  if (!candidate) return '';

  if (candidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(candidate);
      const found = findUrl(parsed);
      if (found) candidate = found;
    } catch { /* fallthrough */ }
  }

  if (candidate.startsWith(DEC_PREFIX)) {
    const rest = candidate.slice(DEC_PREFIX.length);
    if (rest.length <= 16) return '';
    const key = Buffer.from(rest.slice(0, 16), 'utf8');
    const cipherB64 = rest.slice(16);

    // 优先按 base64 密文解密（忽略非法字符，对齐 b64decode(validate=False)）
    try {
      const encrypted = Buffer.from(cipherB64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
      if (encrypted.length) {
        const cipher = createDecipheriv('aes-128-cbc', key, key);
        const result = Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8').trim();
        if (result.startsWith('http')) return result;
      }
    } catch { /* fallthrough */ }

    // 兜底：密文本身是 raw bytes
    try {
      const rawText = [...cipherB64].filter((ch) => ch.codePointAt(0) < 256).join('');
      const raw = Buffer.from(rawText, 'latin1');
      if (raw.length && raw.length % 16 === 0) {
        const cipher = createDecipheriv('aes-128-cbc', key, key);
        const result = Buffer.concat([cipher.update(raw), cipher.final()]).toString('utf8').trim();
        if (result.startsWith('http')) return result;
      }
    } catch { /* fallthrough */ }

    return '';
  }

  return candidate;
}

// 按指定 parsesId 解析一次，返回解出的真实地址（失败返回空串）。
async function parseRound(raw, parseId) {
  const target = `${PARSE_API}${encodeURIComponent(raw)}&parsesId=${parseId}`;
  try {
    const response = await req.get(target, {
      headers: PARSE_HEADERS,
      timeout: 30000,
      maxRedirects: 5,
      maxContentLength: 2 * 1024 * 1024,
      // 不自动抛错，自己判断状态码
      validateStatus: () => true,
    });
    // parsesId 失效时回的是 HTTP 500 的 ThinkPHP 错误页，直接跳过，避免把 HTML 当成地址。
    if (response.status !== 200 || !response.data) return '';
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    if (body.slice(0, 2000).includes('System Error')) return '';
    const resolved = resolveParse(body);
    if (resolved && resolved.startsWith('http')) return resolved;
  } catch { /* fallthrough */ }
  return '';
}

// 对齐 parse_url：固定 pid 下多轮退避重试，成功即返回。
async function parseUrl(raw, parseId = PARSE_ID_WEB) {
  if (!raw) return '';
  for (let rnd = 0; rnd < PARSE_ROUNDS; rnd++) {
    if (rnd > 0) await sleep(rnd * PARSE_BACKOFF * 1000);
    const resolved = await parseRound(raw, parseId);
    if (resolved) return resolved;
  }
  return '';
}

// 按 pid 序列级联：任一 pid 出地址即停
async function parseCascade(raw, parseIds) {
  for (const pid of parseIds) {
    const resolved = await parseUrl(raw, pid);
    if (resolved) return resolved;
  }
  return '';
}

async function home(inReq) {
  const cacheKey = buildHomeCacheKey(KEY, inReq);
  const cached = getHomeCache(cacheKey);
  if (cached) return cached;
  const data = await cms('nav', { token: '' });
  const classes = [];
  const filters = {};
  for (const item of listOf(data.list)) {
    if (item?.type_id == null || !text(item.type_name)) continue;
    const id = String(item.type_id);
    classes.push({ type_id: id, type_name: text(item.type_name) });
    const extend = objectOf(item.type_extend);
    const groups = [];
    for (const [key, name] of Object.entries(FILTER_NAMES)) {
      const values = [...new Set(text(extend[key]).split(',').map(text).filter(Boolean))];
      if (values.length) groups.push({ key, name, init: '', value: [{ n: '全部', v: '' }, ...values.map((v) => ({ n: v, v }))] });
    }
    if (groups.length) filters[id] = groups;
  }
  const result = { class: classes, filters };
  if (classes.length) setHomeCache(cacheKey, result, HOME_CACHE_TTL.semiStatic);
  return result;
}

async function homeVod() {
  const data = await cms('index_video', { token: '' });
  return { list: listOf(data.list).flatMap((item) => listOf(item?.vlist)) };
}

function paginated(data, requestedPage) {
  const list = listOf(data.list);
  const page = pageOf(data.page ?? requestedPage);
  const limit = Number(data.limit) > 0 ? Number(data.limit) : PAGE_LIMIT;
  const hasPagecount = Number(data.pagecount) > 0;
  const pagecount = hasPagecount ? Number(data.pagecount) : page + (list.length >= limit ? 1 : 0);
  // search.total 实测是当前页条数，并非匹配总数，不能用它截断搜索翻页。
  const total = hasPagecount && Number(data.total) >= 0
    ? Number(data.total) : (page - 1) * limit + list.length + (pagecount > page ? 1 : 0);
  return { ...data, page, pagecount, limit, total, list };
}

async function category(inReq) {
  const body = inReq.body || {};
  const page = pageOf(body.page ?? body.pg);
  const id = text(body.id ?? body.tid);
  if (!id) return paginated({ list: [] }, page);
  const filters = objectOf(body.filters ?? body.extend);
  const params = { tid: id, pg: String(page), limit: '18' };
  for (const key of Object.keys(FILTER_NAMES)) {
    const value = text(filters[key]);
    if (value && value !== 'all') params[key] = value;
  }
  return paginated(await cms('video', params), page);
}

function playlist(value) {
  return text(value).split('#').flatMap((entry) => {
    const separator = entry.indexOf('$');
    if (separator <= 0 || !text(entry.slice(separator + 1))) return [];
    return [`${text(entry.slice(0, separator))}$${decryptLvdou(entry.slice(separator + 1))}`];
  }).join('#');
}

async function detail(inReq) {
  const input = inReq.body?.id;
  const ids = (Array.isArray(input) ? input : [input]).map(text).filter(Boolean);
  const list = [];
  for (const id of ids) {
    const data = (await cms('video_detail', { id })).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const { vod_url_with_player: players, ...vod } = data;
    const names = text(vod.vod_play_from).split('$$$');
    const sources = Array.isArray(players)
      ? players
      : text(vod.vod_play_url).split('$$$').map((url, i) => ({ name: names[i], url }));
    const froms = [];
    const urls = [];
    for (const [index, source] of sources.entries()) {
      if (!source || typeof source !== 'object') continue;
      const url = playlist(source?.url);
      if (!url) continue;
      // 注意：这里不再做源站 404 健康检查滤线。4K 直链域名本体全 404，
      // 但播放时由 pid8 换成联通云盘/天翼云直链照样能播，提前隐藏会把可用线路误杀。
      const name = text(source?.name) || text(source?.code) || `线路${index + 1}`;
      froms.push(name.replace(/[$#]/g, ' '));
      urls.push(url);
    }
    list.push({ ...vod, vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$') });
  }
  return { list };
}

async function search(inReq) {
  const body = inReq.body || {};
  const wd = text(body.wd ?? body.key);
  const page = pageOf(body.page ?? body.pg);
  if (!wd) return paginated({ list: [] }, page);
  const data = await cms('search', { text: wd, pg: String(page) });
  const list = listOf(data.list).map(({ type, ...vod }) => vod);
  return paginated({ ...data, list }, page);
}

/**
 * 按线路类型分流解析：
 *   - 4K 直链（ym4kjx 的 mp4/mkv，源站已 404）→ pid8 → 6 → 7 级联换链到
 *     联通云盘/天翼云直链；全败退回原直链（兼容源站还活着的网络）。
 *   - m3u8/mpd 直链 → 原样交给播放器，不解析。
 *   - 网页线路（腾讯/爱奇艺/芒果…）→ pid7 → 5 → 8 级联解析出 m3u8。
 */
async function play(inReq) {
  let original = decryptLvdou(inReq.body?.id);
  if (!original) {
    return { parse: 0, url: '', header: { ...PARSE_HEADERS }, msg: '影探4K：播放地址为空' };
  }

  // 兼容老加密：ldmax 前缀先本地解密
  if (isLdmaxUrl(original)) {
    const decrypted = decryptLdmax(original);
    if (decrypted) original = decrypted;
  }

  // 解析结果缓存
  const now = Date.now();
  const cached = playCache.get(original);
  if (cached && cached.expireAt > now) {
    return { parse: 0, url: cached.url, header: { ...PARSE_HEADERS } };
  }

  let resolved = '';
  if (is4kSource(original)) {
    // 4K 换链: pid8 → 6 → 7 级联; 全败退回原直链(网络内源站还活着的场景)
    resolved = await parseCascade(original, PARSE_FALLBACK_4K) || original;
  } else if (isStreamUrl(original)) {
    resolved = original;
  } else {
    // 网页线路: pid7 → 5 → 8 级联; 全败且是媒体直链就原样交播放器
    resolved = await parseCascade(original, PARSE_FALLBACK_WEB);
    if (!resolved && isMediaUrl(original)) resolved = original;
  }

  if (resolved) playCache.set(original, { expireAt: now + PLAY_CACHE_TTL * 1000, url: resolved });

  if (!resolved) {
    // 解析整条链路失败：给出可读原因，等用户反馈具体线路
    return {
      parse: 0, url: '', header: { ...PARSE_HEADERS },
      msg: '影探4K：解析失败（解析接口返回异常或该线路暂不可用），请换线路重试',
    };
  }
  return { parse: 0, url: resolved, header: { ...PARSE_HEADERS } };
}

export default {
  meta: { key: KEY, name: '🎬 影探4K', type: 3 },
  api: async (fastify) => {
    fastify.post('/init', async () => ({}));
    fastify.post('/home', home);
    fastify.post('/homeVod', homeVod);
    fastify.post('/category', category);
    fastify.post('/detail', detail);
    fastify.post('/play', play);
    fastify.post('/search', search);
  },
};
