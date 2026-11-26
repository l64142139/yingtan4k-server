// 影探4K 独立接口服务：把插件里的 /init /home /homeVod /category /detail /play /search
// 挂到一个 fastify 实例上，直接对外提供 TVBox / 猫影视 / 猫爪 兼容的自定义接口。
//
// 用法：
//   npm install
//   node server.js            # 默认 0.0.0.0:8080
//   PORT=9000 node server.js  # 换端口
import Fastify from 'fastify';
import plugin from './plugins/yingtan4k/index.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

// 允许网页版 / 跨域客户端直接调用
app.addHook('onSend', async (request, reply, payload) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return payload;
});

app.options('/*', async (request, reply) => reply.code(204).send());
app.get('/', async () => ({ ok: true, name: '影探4K 接口服务', routes: ['/home', '/homeVod', '/category', '/detail', '/play', '/search'] }));
app.get('/health', async () => ({ ok: true }));

await plugin.api(app);

app.setErrorHandler((err, request, reply) => {
  reply.code(200).send({ code: 0, msg: `影探4K 服务出错：${err.message}` });
});

await app.listen({ port: PORT, host: HOST });
console.log(`影探4K 接口服务已启动：http://${HOST}:${PORT}`);
