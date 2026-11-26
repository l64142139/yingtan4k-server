# 影探4K · 自托管接口服务

把你上传的 `影探4k-新版.js` 包成一个可以直接跑、直接给播放器用的接口服务。

## 为什么不能直接“塞进”那个在线猫源

`https://woleigedouer:woleigedouer@catpaw.douer.me/index.js.md5` 是豆儿对外公开的**只读**托管（整包 JS + md5），根路径、`/admin`、`/upload`、`/api` 全是 404，`PUT`/`OPTIONS` 也不通，没有任何上传口。它上面的 `index.js` 是一整套带运行时的客户端大包（9MB 级），不是“放个文件就能加一条源”的目录。

另外，你这个 17.7KB 的文件是**服务端插件格式**（`import req from '../../util/req.js'`、`fastify.post('/home' …)`），客户端 JS 引擎跑不了它。所以正确做法是：**让它自己跑成一个 HTTP 接口服务，再把地址当作“自定义接口/单线路”加进播放器。**

## 目录结构

```
yingtan4k-server/
├── plugins/yingtan4k/index.js   # 你的源（与上传文件逐字节一致）
├── util/req.js                  # 插件依赖：HTTP 请求
├── util/home-cache.js           # 插件依赖：首页缓存
├── server.js                    # 起 fastify，挂 /home /homeVod /category /detail /play /search
├── package.json
├── Dockerfile / render.yaml
├── 启动.sh / 启动.bat
└── 单线路配置.json               # 粘贴给播放器用
```

## 放到 GitHub 之后，怎么真正跑起来

GitHub 本身只存代码；GitHub Pages 是静态托管，**跑不了 Node 服务**（fastify 需要真实监听端口），所以不能只靠仓库地址当接口用。三种真正能跑的方式：

**1. 免费容器平台（推荐，从仓库一键部署）**

- Render：New → Web Service → 选本仓库 → 自动识别 `Dockerfile` → Deploy，得到 `https://xxx.onrender.com`
- Zeabur / Railway / Koyeb：同样选仓库、选 Docker 构建即可

拿到域名后直接当接口地址用。

**2. 自己的 VPS / NAS**

```bash
git clone https://github.com/l64142139/yingtan4k-server.git
cd yingtan4k-server
npm install && PORT=8080 node server.js
# 或
docker build -t yingtan4k . && docker run -d --restart=always -p 8080:8080 yingtan4k
```

**3. 家里电脑直接双击 `启动.bat`（Windows）/ `./启动.sh`（Linux/Mac）** —— 局域网地址就是 `http://192.168.x.x:8080`。

## 接到播放器里

把 `单线路配置.json` 里的 `127.0.0.1:8080` 换成实际地址，整段贴进“单线路 / 自定义源”；只收 API 地址的壳子就只填 `http://你的地址:8080`，`type` 选 3（HTTP 接口），搜索、筛选打开。

## 自测

```bash
curl -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8080/home
curl -X POST -H 'Content-Type: application/json' -d '{"id":"1","page":1}' http://127.0.0.1:8080/category
curl -X POST -H 'Content-Type: application/json' -d '{"wd":"狂飙","page":1}' http://127.0.0.1:8080/search
curl -X POST -H 'Content-Type: application/json' -d '{"id":"86706"}' http://127.0.0.1:8080/detail
```

2026-11-26 实测：`/home` 27 个分类；`/category` id=1 第 1/25 页、488 条；`/detail` 86706 大秦文公 3 条线路（联通云/移动云/爱奇艺）；`/play` 4K 直链经 pid8 换成联通云 `hydownload.pan.wo.cn` 直链，爱奇艺页面经 pid7 解出 `api.69mzf.cn/...m3u8`；`/search` 狂飙有结果。

## 注意

- 换端口用 `PORT=9000 node server.js`；`server.js` 默认监听 `0.0.0.0`，局域网可直连。
- 源站域名/CMS key 变了，只改 `plugins/yingtan4k/index.js` 顶部的 `HOST`、`CMS_KEY`、`PARSE_API` 三个常量。
- 解析 pid 由服务商动态更换，脚本已有 7→5→8、8→6→7 级联备援；全线失效时重扫 pid 1~12。
- 本服务不存任何视频文件、不带账号体系；挂公网建议加访问控制或只在内网/组网使用。
