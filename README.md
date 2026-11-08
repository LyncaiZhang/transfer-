[README.md](https://github.com/user-attachments/files/34543736/README.md)
# 问津 Render 公网部署仓库

## 这个仓库是什么

`pages_app/` 是问津 Node 22 动态页移植版；`render.yaml` 是可选 Blueprint。它不需要模型 key，使用构建期快照；页面可输入新材料，阶段由冻结判据给出。

## 方式一：Render 网页手动建 Web Service（推荐）

1. 登录 https://render.com/。
2. 新建一个 **Public GitHub 仓库**，把本目录的 `pages_app/` 整个文件夹上传到仓库根目录。
3. Render 控制台 → **New +** → **Web Service**。
4. 选择 **Public Git repository**，粘贴 `https://github.com/<你的用户名>/<仓库名>`。
5. 填写：
   - Name：`wenjin-public`
   - Region：任选离你近的
   - Branch：`main`
   - Root Directory：`pages_app`
   - Runtime：`Node`
   - Build Command：`npm install`
   - Start Command：`node server.js`
   - Health Check Path：`/api/health`
   - Instance Type：`Free`
6. 环境变量（可选但建议）：
   - `HOST=0.0.0.0`
   - `NODE_VERSION=22`
   - 不填 `WENJIN_API_KEY`；公网页默认模型关闭。
7. 点 **Create Web Service**，等日志出现 `server listening`。
8. 打开 Render 给的 `https://<service>.onrender.com`，测试：
   - 首页能打开
   - `/api/health` 返回 `status: ok`
   - 390px 窄屏无横向溢出
   - 报告页打印/PDF 正常

## 方式二：Blueprint

仓库根目录已有 `render.yaml`：

1. Render → **New +** → **Blueprint**；
2. 连接同一个公开仓库；
3. 按提示 Create；
4. 同样等待部署。

## 免费实例注意事项

- Render Free 会在一段时间无访问后休眠，评委第一次打开可能等 30–60 秒；正式演示前先唤醒。
- 免费实例不需要数据库；数据使用 `db/seed_snapshot.json`。
- 若要自定义域名，Render 服务页 → Settings → Custom Domain；也可先用 `onrender.com` 子域名。
- 不把 `.env`、模型 key、Supabase service key 上传到仓库。

## 当前已测

- `node tests/parity.mjs`：20/20
- 本机 `PORT=8081 node server.js`：`/api/health` ok，页面标题正常
- 公网页模型默认关闭；判据 `run_triage.v1-frozen-20261028`
