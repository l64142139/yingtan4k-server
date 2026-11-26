// 极简 req 工具：对齐插件里用到的 axios 式调用（get/post + status/data）
import axios from 'axios';

function normalize(opts = {}) {
  const {
    headers = {},
    timeout = 15000,
    maxRedirects = 5,
    maxContentLength = 2 * 1024 * 1024,
    validateStatus,
    responseType = 'text',
  } = opts;
  return {
    headers,
    timeout,
    maxRedirects,
    maxContentLength,
    responseType,
    validateStatus: validateStatus || ((s) => s >= 200 && s < 300),
  };
}

const req = {
  async get(url, opts = {}) {
    const res = await axios.get(url, { ...normalize(opts) });
    return { status: res.status, data: res.data, headers: res.headers };
  },
  async post(url, body, opts = {}) {
    const res = await axios.post(url, body, { ...normalize(opts) });
    return { status: res.status, data: res.data, headers: res.headers };
  },
  async request(config = {}) {
    const res = await axios.request({ ...config, ...normalize(config) });
    return { status: res.status, data: res.data, headers: res.headers };
  },
};

export default req;
