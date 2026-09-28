# 治疗室派工

给治疗室几台手机共用的今日派工单：在人体上点要做的肌肉和节点，记住病症里的顺序，派给谁、完成只记在今天。

**每天用它干活的人看 [docs/治疗室使用说明.md](docs/治疗室使用说明.md)。**

## 功能一览（第二阶段新增）

- **病症模板**：调好一套手法「存为模板」，新病人一键套用；老病人新毛病「套用模板」直接挂进今天（`shared/catalog.js` 外的目标不进模板）。
- **名单加项**：不转模型，搜肌肉名或拼音首字母直接加项，深层肌肉（肩袖等被盖住的）也点得到；`client/src/pinyin.js`。
- **说一句快速开单**：`shared/quick-order.js` 的封闭词表解析器（33 目标同义词 + 手法 + 方向 + 左右双 + 中文数字），一句话变清单，语音靠手机键盘自带的话筒，不需要任何模型。
- **照上次的单**：一键复制病人最近一天的实际单（含顺序和派给谁），`POST /api/today/entries/repeat-last`。
- **来过几次**：加入病人时显示「上次做了」摘要；病人页「来过几次」看全部历史（`visitHistory`，最近 12 次）。
- **打印交班单**：今日单顶部「打印」，按人分组的一页纸，含进度和红字提醒（`.print-sheet` + `@media print`）。
- **按人视图**：今日单第三个标签，主治一眼看谁手里多少活；未派的排最后。
- **目标目录 33 个**：大腿髋（内收肌群/缝匠肌/腘肌/髂腰肌/梨状肌）、小腿足（胫骨前后肌/腓骨肌/趾长伸屈肌）、肩背颈（斜方肌/肩胛提肌/菱形肌/前锯肌/肩袖四肌/胸锁乳突肌），映射见 `shared/body-map.js`。
- **病人备注/禁忌**：一句话红字常驻今日单和病人页，`POST /api/patients/:id/note`。
- **找病人**：按最近来过的日子排序，搜索名字/病症/拼音首字母，同名建档有提醒。
- **派给我的**：今日单顶部切换，徽标是没完成的项数，有新活震动提示；清单第一项未完成的带 ▶ 当前标记。
- **删除撤销**：左滑去掉后 5 秒内可撤销，位置和手法原样放回。
- **上次派给谁**：全部派给面板一键照旧。
- **安卓返回键分层**：返回键先关弹层、再退出病人页（含「记回病症」提醒），不直接退出应用；`client/src/back-layer.js`。
- **实时同步**：`GET /api/events`（SSE）数据一变推给各台手机，下拉刷新仍然可用。

## 本机开发

```bash
npm install
npm test
npm run dev
```

电脑浏览器打开 http://127.0.0.1:5173/  
同一 Wi‑Fi 里的手机打开终端里打印的 `http://<电脑局域网IP>:5173/`

同一浏览器的两个标签是同一台手机。要在电脑上模拟两台手机，用两个浏览器，或给地址加上 `?device=1` 和 `?device=2`。

第一台打开的手机写下自己的名字。之后的手机点「我是谁」选名字或加新名字。关掉页面后仍会记住这台手机。

## 打包后只开一个服务

```bash
npm run build
npm start
```

页面和接口都在 `http://<电脑IP>:8787/`。

可选 HTTPS（手机添加到主屏幕需要）：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout data/server.key -out data/server.crt -subj "/CN=clinic"
TLS_KEY=data/server.key TLS_CERT=data/server.crt npm start
```

## 数据放哪儿、怎么保住

- 全部数据只在 `data/clinic.json`，不上云、不经第三方。
- 每次保存前自动抄一份到 `data/backups/`：最近 30 份分钟级 + 每天 1 份保留 30 天。
- `GET /api/data/export?deviceId=…` 导出完整 JSON，`POST /api/data/import` 凭已绑定设备导入。
- 谁改了什么记在 `data/audit.log`（超 5MB 自动轮转）。

## 模型和图标

- 人体网格来自 BodyParts3D（© Database Center for Life Science，CC BY 4.0），原始文件在 `assets/body-source/`，页面实际加载的是 Draco 压缩版（`client/public/body/`）。重新压缩：`npm run optimize:body`，压缩后 `shared/body-assets.js` 里的版本号自动更新，用于浏览器换缓存。
- Draco 解码器复制自 three 自带文件（`client/public/draco/`），前端离线可用。
- PWA 图标由 `npm run icons` 用纯 Node 生成（`scripts/make-icons.mjs`），改配色去那里改。

## 今日单上的设置

- **我是谁**：换当前这台手机绑定的名字。
- **病症模板**：删除不用的模板。

人体上点左右侧会分开记。同一块肌肉点两次，模型上会显示两个序号。两指捏合或「靠近 / 远离」可以缩放。
