// 首页缓存（内存版）：给 nav 分类这种半静态数据用
const store = new Map();

// 单位：毫秒
export const HOME_CACHE_TTL = {
  semiStatic: 60 * 60 * 1000, // 1 小时
  short: 10 * 60 * 1000,      // 10 分钟
};

export function buildHomeCacheKey(key, inReq) {
  const body = (inReq && inReq.body) || {};
  const filters = body.filters || body.extend || {};
  const stable = Object.keys(filters)
    .sort()
    .map((k) => `${k}=${filters[k]}`)
    .join('&');
  return `${key}|${stable}`;
}

export function getHomeCache(cacheKey) {
  const item = store.get(cacheKey);
  if (!item) return null;
  if (item.expireAt <= Date.now()) {
    store.delete(cacheKey);
    return null;
  }
  return item.value;
}

export function setHomeCache(cacheKey, value, ttl = HOME_CACHE_TTL.semiStatic) {
  store.set(cacheKey, { value, expireAt: Date.now() + ttl });
  return value;
}
