# 红果短剧 · LG webOS 客户端

把「红果短剧」（hongguoduanju.com / 番茄系）搬到 **LG webOS 6+ 电视**上。

架构参照 [asdf17128/bili-webos](https://github.com/asdf17128/bili-webos)（React + Vite 前端 + webOS JS Service 后端 + 本机媒体代理），数据接口参照 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV)（其 `server/vendor/hongguo.cjs` 源自 drpys 项目，GPL-3.0）。

## 安装包下载

不想自己构建的话，直接取已发布版本：

**[⬇️ 下载最新 ipk](https://github.com/wymam/hongguo-webos/releases/latest)** —— 见 [Releases 页](https://github.com/wymam/hongguo-webos/releases)

| 版本 | 文件 | 大小 | 校验（MD5） |
|---|---|---|---|
| v1.0.0 | `com.hongguowebos.app_1.0.0_all.ipk` | 159,596 bytes | `99291f3258bc0388ce4e3d32f37fbf57` |

安装方式见下方「部署机制」章节（需先在电视上开启 Developer Mode）。

---

## 为什么最低只支持 webOS 6+

这是本项目**唯一的硬约束**，也是整个工程的起点。

红果的接口需要字节系签名，签名链路用到五个密码学原语：

| 原语 | Node 16 (webOS 6+) | Node 8 (webOS 5) | Node 0.12 (webOS 4.x) |
| --- | --- | --- | --- |
| `md5` | 原生 | 原生 | 原生 |
| `sha512` | 原生 | 原生 | 原生 |
| `aes-128-cbc` | 原生 | 原生 | 原生 |
| `aes-128-ctr` | 原生 | 原生 | 原生 |
| **`sm3`** | ❌ `node:crypto` 未注册 | ❌ 连 OpenSSL 都没有 | ❌ 连 OpenSSL 都没有 |

webOS 6+ 的 Node 16 底层 OpenSSL 1.1.1 **支持** SM3，但 `node:crypto` 没有把它注册成可选 digest，`crypto.createHash('sm3')` 会抛 `ERR_CRYPTO_INVALID_DIGEST`。

所以缺的**只有 SM3 一个**。本项目用约 200 行纯 JS 实现了 SM3（GB/T 32905-2016），并在 `crypto-shim.js` 里做**特征检测 + 原地 patch**：

- 电视上有原生 SM3 → 什么都不做，走原生
- 没有原生 SM3 → 只改写 `crypto.createHash('sm3')`，透明返回纯 JS 实现

**上游 vendored 的签名代码一行都不用改。**

正确性用两组手段验证过：

- GB/T 32905-2016 官方标准向量（`abc` → `66c7f0f4…`）
- 与 `node:crypto` 原生实现做**差分 fuzz**：0–199 连续长度 + 55/56/57/63/64/65/119/120/121/127/128/129 + 1000/4095/4096/4097 + 100000/1000000 字节，以及 50 组随机分块 `update`

结果：**268 组逐字节一致**。

webOS 5 及更早是 Node 8 / Node 0.12，连 `Buffer` 行为和 `http` 兼容层都差得远，移植成本远超收益，因此明确不支持。

---

## 功能

- **首页推荐**：Hero 轮播（有焦点时自动暂停）+ 多栏目横向货架
- **分类浏览**：真人剧 / 漫剧 / AI剧，带题材筛选与分页
- **剧集详情**：封面、评分、标签、简介、选集网格（6 列）、续播定位
- **播放**：原生 `<video>` 直连本机媒体代理，支持 Range 拖动、上一集/下一集、自动播下一集、10 秒快进快退
- **收藏 / 观看记录 / 播放进度**：全部本机存储（红果官方无账号同步接口）
- **设置**：每行卡片数、界面字号、自动播放，以及**在机诊断页**

### 焦点与性能

遥控器导航不经过 React state：

- 焦点用 `classList` 变异直接改 DOM，按键不触发重渲染
- 网格滚动是 `transform: translateY`（不是 `overflow: scroll`），偏移量存在 `ref` 里
- 滚动位置**按目标行真实 `offsetTop` 计算**，不用「行高 × 行号」公式——卡片高度会随标题换行变化，固定 pitch 会累积误差导致聚焦卡被裁切

实测参照项目同类结构：滚动偏移若进 React state，100+ 卡片时 p95 输入延迟从 29ms 退化到 92ms。

两条**不能违反**的不变式（都是实测踩出来的，改回去就会静默失效）：

1. **滚动偏移必须同步写入，动画只能是装饰。**
   `.video-grid` 上不得出现 `transition: transform`——属性是命令式写入的，transition 会把它押在旧值上直到 transition 推进，而**不产出合成帧的表面（GPU 关闭、被遮挡、后台）永远不推进**，结果网格冻在旧偏移、聚焦卡停在屏外。同一原因，滚动也**不能只靠 rAF 驱动**：`requestAnimationFrame` 只在实际投递帧时才回调。`ShelfGrid.animateTo()` 因此先同步 `applyOffset(next)` 提交终值，再用 rAF 做缓动；终值永不被回滚。
2. **标题行不得占用可导航的行号。**
   `navigateGrid` 是按 `group-row-col` 做纯算术（`row ± 1`）寻址的，只能命中注册表里存在的行号。标题行不可聚焦，所以它的 `row` 为 `null`、不参与编号。若让标题行吃掉一个行号，行号序列就出现空洞（实测出现过 `1,2,4,5,7,8`），`row + 1` 查不到、同行回退也查不到，**方向键会在该行永久卡死**。
   `tools/nav-check.js` 因此把「滚动决策覆盖的行号连续」列为断言而非可选项。

---

## 架构

```
┌─────────────────────────── TV (webOS 6+) ───────────────────────────┐
│                                                                     │
│  ┌── Web App (file://) ────────────┐   ┌── JS Service (Node 16) ──┐ │
│  │ React 18 + Vite                 │   │ Luna 方法：              │ │
│  │ 焦点系统 / 网格 / 播放器         │◄──┤  getHome getCategory     │ │
│  │                                 │   │  getSearch getDetail     │ │
│  │                                 │   │  ping getDiagnostics     │ │
│  └─────────────┬───────────────────┘   │                          │ │
│                │ Luna bridge           │  ┌── MediaProxy ──────┐  │ │
│                │                       │  │ 127.0.0.1:7655     │  │ │
│                │  <video src=          │  │ HTTP Range → 206   │  │ │
│                └─ http://127.0.0.1 ───►│  └────────┬───────────┘  │ │
│                     :7655/media/<id>   └───────────┼──────────────┘ │
└────────────────────────────────────────────────────┼────────────────┘
                                                     │
                          ┌──────────────────────────▼─────────────────┐
                          │ vm 沙箱                                    │
                          │  vendored hongguo.cjs (GPL-3.0, 未修改)    │
                          │  ├─ 签名层 (md5/sha512/sm3/aes)            │
                          │  ├─ SPADE URL 解密                         │
                          │  ├─ CENC 内容密钥派生                      │
                          │  └─ AES-128-CTR 逐样本解密                 │
                          └────────────────────────────────────────────┘
```

### 播放链路

```
video_model (签名 POST)
    └─► fallback_api → video_list
            └─► decryptSpadeUrl            AES-128-CBC + sha512 派生
                    └─► deriveContentKey   spade_a → CENC 内容密钥
                            └─► proxy_rule 按 __range 拉远端 1MB 段
                                    └─► decryptPartial  AES-128-CTR 逐样本解密
                                            └─► 206 + base64 回传
```

主流是模式化 MP4（CENC），所以 **不需要 DASH/HLS，也就不需要 shaka-player**——这一点与 bili-webos 有本质差异，直接省掉约 770KB。

### 关键设计

**媒体代理分块**：`SEG_SIZE = 1MB`。任何 Range 请求都被钳制到一段以内，避免一次解密几十 MB 撑爆内存、也避免长时间阻塞 Luna。

**并发上限 4 个流**，超出返回 `503 + Retry-After: 2`。播放时会有大量顺序 1MB 段请求，HTTP `keep-alive` agent 复用连接。

**端口占用自增**：服务默认绑 `7655`（与 bili 的 7654 区分），被占用则最多向上重试 8 次；前端通过 `ping` 拿真实端口，不写死。

**先解密再写响应头**：媒体代理先把这一段解出来，成功了才写 `206`；失败则干净返回 `502`，而不是吐一个被截断的 206 让 `<video>` 卡死。

**零依赖 HTTP 客户端**：webOS 服务运行时没有 `npm install`，往 `.ipk` 里塞 axios 要多 ~1.5MB。本项目用 Node 原生 `http`/`https` 实现了 axios 兼容子集（`axios()` / `axios.get` / `axios.post` / `responseType: 'text' | 'arraybuffer'`），返回形状与 axios 一致。

**vm 沙箱白名单**：vendored 源码在一个只注入了必要能力的 `vm` context 里求值：

```js
vm.createContext({
  require: (name) => (name === 'node:crypto' || name === 'crypto') ? crypto : throwErr(name),
  Buffer, URL, URLSearchParams, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON,
  process: { env: {} },
  axios: httpClient
});
```

`require` 只放行 `crypto`，出站网络只能走 `axios`（受超时与 32MB 上限约束）。

**webOS file:// 兼容**：`.ipk` 内页面从 `file://` 加载，`<script type="module">` 会被严格 MIME 检查拒掉导致白屏。`@vitejs/plugin-legacy` 配 `renderModernChunks: false` 只输出 classic SystemJS；另有插件剥掉 `crossorigin` 与 `modulepreload`，并注入 `globalThis` polyfill。

---

## 目录结构

```
hongguo-webos/
├── app/                                  # 前端（打进 .ipk 的 web 部分）
│   ├── index.html
│   ├── vite.config.js
│   ├── public/webOSTVjs-1.2.13/          # webOS TV JS 库
│   ├── webos-meta/                       # appinfo.json + icon.png + largeIcon.png
│   └── src/
│       ├── main.jsx  App.jsx  styles.css
│       ├── api/client.js                 # Luna 桥
│       ├── hooks/useFocus.js             # 焦点系统（零渲染）
│       ├── components/                   # ShelfGrid / VideoCard / Common
│       ├── pages/                        # Home / Category / Detail / Search / Library / Settings
│       ├── player/PlayerPage.jsx
│       └── utils/                        # storage / thumb / format / perfFlags
├── service/com.hongguowebos.app.service/ # 后端（Luna 服务 + 媒体代理）
│   ├── service.js                        # Luna 方法 + HTTP 媒体代理
│   ├── provider.js                       # vm 加载 + 数据形状适配
│   ├── sm3.js                            # 纯 JS SM3
│   ├── crypto-shim.js                    # SM3 特征检测与 patch
│   ├── http-client.js                    # axios 兼容零依赖客户端
│   ├── compat.js                         # Node 16 兼容垫片
│   └── vendor/                           # hongguo.cjs (GPL-3.0) + NOTICE + LICENSE
├── tools/                                # 验证脚本与探测脚本
├── build.sh
└── package.json
```

---

## 构建

前置：`@webosose/ares-cli`

```bash
npm install -g @webosose/ares-cli
```

打包：

```bash
./build.sh
# -> dist/com.hongguowebos.app_1.0.0_all.ipk
```

`build.sh` 会自动在 `app/` 里装依赖（默认走 `registry.npmmirror.com`，可用 `NPM_REGISTRY` 覆盖）、构建、拷贝 webOS 元数据、然后调 `ares-package`。

**前置：webOS CLI。** 脚本会自行定位 `ares-package`，查找顺序是 `$ARES_DIR` → 受管隔离目录 → `PATH`。都没找到就会打印安装命令并退出。若受限环境不允许包自身的 postinstall 运行，可跳过它安装（CLI 本身是纯 JS，手动 `node` 调用即可）：

```bash
npm i --prefix "$HOME/.workbuddy/binaries/node/workspace" \
      --ignore-scripts --registry=https://registry.npmmirror.com \
      @webos-tools/cli
```

> 注意：**不要给 `ares-package` 传 `--no-minify`**。`@webos-tools/cli` 3.x 没有这个选项，传了会被解析成位置参数并报 `The specified path does not exist <package>`。`build.sh` 已按 3.2.6 的用法写。

### 部署到电视

先在电视上打开 **Developer Mode** 并记下设备名：

```bash
ares-setup-device            # 添加设备
ares-device-info -d tv       # 验证连通
./build.sh --deploy          # 或 TV_DEVICE=tv ./build.sh --deploy
```

手动安装：

```bash
ares-install --device tv dist/com.hongguowebos.app_1.0.0_all.ipk
ares-launch  --device tv com.hongguowebos.app
```

---

## 验证

**服务端**（全部可离线运行，`smoke-live.js` 需要联网）：

```bash
node tools/verify-sm3.js          # SM3 标准向量 + 268 组差分 fuzz
node tools/verify-sm3-shim.js     # 模拟「无原生 SM3」环境，验证 shim 生效
node tools/verify-provider.js     # vm 加载、缓存、crypto 解析
node tools/smoke-live.js --nosm3  # 端到端：首页/分类/详情/取流/解密
node tools/verify-service.js      # Luna 方法 + 真实 HTTP Range 语义
node tools/verify-service-boot.js # 按打包布局加载 service.js，核对 Luna 方法名
```

`--nosm3` 会强制走纯 JS shim 路径，也就是**在模拟 webOS 6 真实环境的条件下**做端到端验证。

`npm run verify` 跑以上全部。

**前端**（无头 Edge，Luna 用桩替身，`npm run verify:ui`）：

```bash
node tools/render-check.js      # 截图 + 13 条 DOM 断言（布局/焦点/无报错）
node tools/dump-registry.js     # 导出可聚焦项的 group-row-col 与行结构
node tools/nav-check.js         # 驱动真实方向键，断言聚焦卡始终完整可见
node tools/scroll-shot.js       # 输出滚动前/后截图（人眼可核对的对比图）
```

导航检验是这里最有价值的一个，因为它断言的是**观众真正在意的那件事**：每次按键之后，聚焦卡是否完整落在视口内。它同时断言**滚动决策覆盖的行号必须连续** —— 这正是下面这条 bug 的回归测试。

### 两个已修复的静默故障（都曾让界面"看起来正常但实际不可用"）

1. **标题行占了可导航行号 → 方向键在第 3 行永久卡死。**
   `ShelfGrid` 的行打包器原本把标题行也计入 `row` 计数，于是注册表里的行号是 `1,2,4,5,7,8`。`navigateGrid` 是纯算术寻址（`row + 1`），查不到 `3` 号行、同行回退也查不到，焦点就停在 `content-2-0` 再也下不去。修复：标题行 `row: null`，不参与编号。

2. **`transform` 被 CSS `transition` 押在旧值上 → 网格根本不滚动。**
   `.video-grid` 上的 `transition: transform .2s ease` 让命令式写入的新偏移一直不生效；在不产出合成帧的环境里（GPU 关闭 / 被遮挡 / 后台）transition 永远不推进，网格就冻在旧偏移、聚焦卡停在屏外。修复：删掉该 transition，改由 `ShelfGrid` 自己驱动缓动，**终值同步写入且永不回滚**。

   > 排查过程中一度把现象误判为"无头浏览器的 transform 读取怪癖"。用一张纯净基线页面做对照才确认：这个无头环境**正常支持** transform（`translateY(-200px)` 让 rect 从 `0` 移到 `-200`）。误判的代价是真实 bug 被测试放过 —— 这也是为什么 `nav-check.js` 现在断言几何（`getBoundingClientRect`）而不是读 computed style。

---

## 已知限制

### 搜索不可用（上游双向拦截）

两条路都被堵死，且**都不是本项目的问题**：

- **App 接口** `api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v` 返回 `HTTP 200` + `content-length: 0` + 空 body。对照实验：**video 端点**返回 200 且带真实 JSON 错误体，说明签名本身是被接受的；未签名的普通 GET 同样得到空 body。结论是**边缘拦截**，不是签名算错。
- **官网 SSR** `/search?query=<kw>` 的 `loaderData.search_page.searchList` 恒为 0 条，且回显 `query: ""`——服务端根本不认这个参数。用站内已存在的精确剧名（「首辅娇娘」「聚宝仙盆」）测试同样是 0 条。

处理方式：`provider.search()` 仍然两路都试（万一放开就能自动恢复），但两路皆空时 **抛 `SEARCH_UNAVAILABLE`**，绝不伪装成空列表。前端明确告诉用户该限制并引导去分类浏览。

### 榜单不可用

`/rank/hot-drama` 返回 200，但 `loaderData` 里的榜单 `content` 是空对象，列表由客户端 JS 拉取，SSR 拿不到。因此当前导航里没有榜单栏目。

### 无账号同步

hongguoTV 上游项目本身就没有实现登录。收藏 / 历史 / 进度全部存在本机电视上，UI 里已声明。

### 真机验证（已完成）

**已在 LG webOS 电视上安装并实测通过。** 实测环境不是 webOS 6，而是：

```
webos_release : 11.2.0        (HE_DTV_W23O_AFABATAA，2023 年机型 OTA 升级后)
core_os       : 11.2.0-3701   Rockhopper / starfish / 内核 6.12.44
node          : v20.12.2
```

注意 `os_info.json` 里的 `1st_boot_version: 4.08.18` 是**固件/引导版本**，不是系统版本 —— 一开始把它误读成「webOS 4」会得出完全相反的结论（以为 Node 0.12、SM3 不可用）。看 `webos_release` 才是系统版本。Node 20 高出 Node 16 下限，SM3 由运行时原生提供，`crypto-shim.js` 的探测正确识别并**跳过了 patch**（`getDiagnostics` 报 `sm3: native`）。

产物：

```
dist/com.hongguowebos.app_1.0.0_all.ipk   (144K)
```

逐项验证结果：

| 验证项 | 结果 |
|---|---|
| SSH 部署 | `prisoner@<tv>:9922`，**仅密钥**认证（见下方「部署机制」） |
| 应用安装 | `/media/developer/apps/usr/palm/applications/com.hongguowebos.app` ✅ |
| 服务安装 | `.../services/com.hongguowebos.app.service`（8 个文件 + `vendor/`）✅ |
| 应用启动 | `WebAppMgr --app-id=com.hongguowebos.app` 常驻，未崩溃 ✅ |
| Luna 服务 | `ping` → `{returnValue:true, node:"v20.12.2", mediaPort:7655}` ✅ |
| 上游签名链路 | `getHome` 返回 **44 条**真实内容；`getDetail` 返回 **76 集** ✅ |
| 媒体代理 | `127.0.0.1:7655` LISTEN；`HEAD` 返回 `206` + `Content-Range: bytes 0-1048575/**22421134**` ✅ |
| CENC 解密 | 段首为 `ftypisom` / `iso2mp41` / `moov` / `mvhd`，即**合法可解 MP4** ✅ |
| **视频播放** | `readyState:4`、`videoWidth:1920`、`videoHeight:1080`、`paused:false`、`duration:83.8s`、`error:null` ✅ |
| 遥控器导航 | 行号 `0→1→2→3` 连续、网格滚动 `617/1238/1819px`、焦点卡片始终在视口内 ✅ |
| 界面渲染 | 真机 DOM：侧栏 8 项、hero、**36 张卡片**、4 个货架标题、有卡片处于 `focused` ✅ |

**H.265 硬解确认可用** —— 这是原先「未验证」清单里风险最高的一条。

## 部署机制（webOS）

真机部署不走 `ares-install`（本机 ares CLI 的 postinstall 会调被安全策略拦截的 `reg.exe`），而是用 `tools/deploy.js` 直连电视，做 ares 在底下做的同一件事：

1. **`prisoner@<tv>:9922` 是仅密钥（key-only）认证**。Development Mode 里那串口令**不是 SSH 密码**，而是**解锁设备下发私钥的口令**。
2. 密钥来自 `GET http://<tv>:9991/webos_rsa` —— 前提是 Developer Mode 里把 **Key Server 打开**，否则 9991 拒绝连接。
3. `ssh2` 传 `privateKey` + `passphrase` 会**原生解包**加密 PEM，不需要自己实现 `EVP_BytesToKey`（手写反而易错）。
4. 之后：SFTP 上传到 `/media/developer/temp/` → `luna-send-pub .../appInstallService/dev/install` → `launch`。

### 两个会浪费大量时间的坑

**坑 1：错误信息指向口令，真凶是密钥被代理改写。**

本机有 `http_proxy`。经代理抓 `:9991/webos_rsa` 会拿到**被改写过的响应**：PEM 头部的字母被替换（`-----BEGIN RSA PRIVATE KEY-----` → `-----PBQOC AQX MHATMYD TIP-----`），体积从 1766 字节变成 6241 字节。而 ssh2 对这两种情况的报错是同一句：

```
Cannot parse privateKey: Malformed OpenSSH private key. Bad passphrase?
```

它把人往「口令错了」的方向带。`deploy.js` 现在会在把密钥交给 ssh2 **之前**校验 PEM 头部与长度，不符就直说是被代理改写了。

**坑 2：`passphrase()` 从整个 `argv` 里找参数，把解释器路径当成了口令。**

```js
// 错：argv[0] 是 node.exe，argv[1] 是脚本路径，两者都不以 '-' 开头
const arg = process.argv.find((a) => a && !a.startsWith('-') && a !== process.argv[1]);
```

`argv[0]`（`...\node.exe`）会被 `find` 选中，于是口令变成 `"C:\...\node.exe"`，ssh2 解密失败，又报出上面那句误导性的 `Malformed ... Bad passphrase?`。正确写法是只在**真正的用户参数**里找：

```js
const arg = process.argv.slice(2).find((a) => a && !a.startsWith('-'));
```

### 服务必须保活，否则播放必失败

这是**最隐蔽的一个 bug**，值得单独记下来。

`webOS` 的 JS 服务不是常驻的。`webos-service` 里有一段：

```js
ActivityManager.prototype._startTimer = function() {
  this._idleTimer = setTimeout(function() {
    if (that.exitOnTimeout) { console.log("no active activities, exiting");
                              process.exit(0); }
  }, this.idleTimeout * 1000);   // idleTimeout 默认 5（秒）
};
```

**最后一次调用结束 5 秒后，服务直接 `process.exit(0)`**，`127.0.0.1:7655` 随之消失。播放要在几分钟里发几百个 Range 请求，任何一次落在进程已死的窗口上就是 `ECONNREFUSED`，而 `<video>` 把它报成：

```
MEDIA_ELEMENT_ERROR: Format error      ← 看起来像编码不支持，其实完全不是
```

这个症状极其容易误判成 H.265 硬解问题。**判据**：把同一段字节在代理活着时手动拉下来检查 —— 如果是合法的 `ftyp`/`moov`，就不是编码问题。

**注意：`setInterval` 保活无效**，因为 `process.exit()` 是显式的，不会被未清空的定时器阻止（实测仍然退出）。正确做法是构造服务时传第三个参数把空闲超时拉长，并在流式传输期间用**引用计数的 activity** 钉住：

```js
var service = new Service(SERVICE_ID, null, { idleTimer: 12 * 60 * 60 });
```

```js
service.activityManager.create('media-stream', function (activity) { ... });
```

## 在真机上排查前端问题

电视上的 `WebAppMgr` 渲染进程会在**电视本机**的 `9998` 端口开一个 Chromium 远程调试端点。`tools/cdp-inspect.js` 通过 SSH 在电视上跑一段自带 WebSocket 组帧的探针（零依赖），可以：

- 读取运行中应用的真实 DOM（`getDiagnostics` 看不到的渲染结果）
- 抓 `console` / `Log` / JS 异常
- 在真机上执行任意表达式，配合 `tools/expr-*.js` 驱动遥控器按键序列

```bash
node tools/cdp-inspect.js <passphrase>                    # 默认：DOM 快照
node tools/cdp-inspect.js <passphrase> tools/expr-nav.js  # 按键导航
node tools/cdp-inspect.js <passphrase> tools/expr-play2.js # 播放状态
```

比截图强：截图只能看到画面，这个能看到 DOM、控制台和错误。

### 重新部署

电视地址不写死在仓库里，用环境变量传入：

```bash
TV_HOST=<tv-ip> node tools/deploy.js <passphrase>
```

可选变量：`TV_PORT`（默认 9922）、`TV_USER`（默认 `prisoner`）、
`TV_KEY_PATH`（默认 `~/.ssh/webos_tv_key`）。

重装后旧实例会导致 `launch` 返回 `errorCode: -102, "app is locked"`。先杀掉再启动：

```bash
pkill -f "app-id=com.hongguowebos.app"
pkill -f "com.hongguowebos.app.service"
```

---

## 许可

本项目的服务端代码以 **GPL-3.0** 发布，因为它链接并分发了 GPL-3.0 的 `hongguo.cjs`。

### 参考与致谢

| 项目 | 参考用途 |
| --- | --- |
| [asdf17128/bili-webos](https://github.com/asdf17128/bili-webos) | **架构参考** —— React + Vite 前端、webOS JS Service 后端、本机媒体代理（HTTP Range 分段解密）、SSH 部署/重启 |
| [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) | **接口 + 解密参考** —— 红果接口签名链路；CENC 解密的 subsample / IV / 样本索引实现（`kotlin-tv/core/.../MediaCrypto.kt`），以及「播放跳集」排查时的逐项对照 |
| [woshishiq1/drpys](https://github.com/woshishiq1/drpys) | **vendored 上游** —— `vendor/hongguo.cjs` 的原始出处（GPL-3.0） |

来源链：

```
woshishiq1/drpys      GPL-3.0   上游 spider
        │
        ▼
N3urda/hongguoTV      GPL-3.0   vendored，改造成 Node 服务
        │
        ▼
this project          GPL-3.0   重新 vendor，封装为 webOS 应用
```

`service/com.hongguowebos.app.service/vendor/hongguo.cjs` 是**逐字节未修改**的上游副本，MD5 `7796a8e3256478fab97b89553583b747`，与上游 pinned commit 一致。详见 `vendor/NOTICE.md`。

---

## 声明

本项目仅为**播放客户端**，不存储、不代理分发任何影视内容。所有内容版权归红果短剧及其权利人所有。请自行评估使用风险。
