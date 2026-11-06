# 完全 Cloudflare 托管：physio.pawpawmaster.com

目标架构：**Workers Static Assets + Worker API + 单个 SQLite Durable Object**，支持 Access、治疗室共用口令和公开演示三种入口。

## 当前配置：公开演示，不需要邮箱或口令

按使用者要求，仓库当前明确设置：

```text
AUTH_MODE=public-demo
PUBLIC_DEMO_ACK=fictional-data-only
```

所有访问者均可查看、修改或导出这间治疗室的模拟数据。页面常驻「公开演示 · 无登录保护」提示，并返回禁止搜索索引的响应头。**只用虚构数据；禁止把这套配置直接用于真实患者资料。** 现有治疗室 ID 和数据库不变，不清空、不迁移现有模拟数据。

**重要：push/重新部署不能取消 Cloudflare 外层 Access。** 如果仍显示邮箱登录，请在 Zero Trust → Access → Applications 移除 `physio.pawpawmaster.com` 的保护：删除只覆盖该主机名的应用，或仅对该应用设置临时 **Bypass / Everyone** 策略。不要把包含其他域名的应用整批放开，也不要关闭其他项目的保护。

部署脚本默认使用仓库的模式。如果构建环境已有 `AUTH_MODE=access`，请改成 `public-demo` 或移除该覆盖变量后重新部署；保留旧的 Access 团队域名/AUD 本身不会触发邮箱验证。

### 随时切回方案 1：治疗室共用口令

1. 在 Worker 的 **Settings → Variables and Secrets** 添加 **Secret** `CLINIC_PASSCODE`，使用 16～256 字符的随机口令，不要写入代码、聊天或普通公开变量。
2. 将 **构建环境变量** `AUTH_MODE` 设置为 `passcode`，重新部署；或本机 `AUTH_MODE=passcode npm run cf:deploy`。不要仅修改运行时普通变量，否则下一次部署可能被仓库配置覆盖。
3. 维持外层邮箱 Access 的 Bypass/关闭状态，浏览器会显示本程序的口令页面，不使用邮箱。每台手机首次输入后用 HttpOnly、Secure、SameSite=Strict Cookie 记住 7 天。
4. 口令尝试在 SQLite 中限流：每个来源每十分钟 10 次、全治疗室每十分钟 100 次；重启不会清零。更换 Secret 会使旧会话失效，旧实时连接也不再接收通知。设置页可退出当前手机的口令登录。

`passcode` 模式缺 Secret 会拒绝访问，绝不会退回公开模式。口令在 Cloudflare 的 Secret 中保存，部署脚本不会把它打包进普通配置。

未指定 `AUTH_MODE` 时认证逻辑仍默认 `access`；模式拼写错误或公开演示缺少明确确认都会拒绝访问。下文 Access 配置仅用于以后切回邮箱保护的情况。

- 前端、人体模型、API、共享派工、设备占用、实时同步、备份全部由 Cloudflare 承载，不需要治疗室电脑常开，不需要 Tunnel。
- Durable Object 是整间治疗室的唯一写入者。数据库写入及审计在事务中完成，成功后才广播；对象休眠或重启后从 SQLite 恢复，不能使用 Workers 临时文件保存患者数据。
- 实时同步使用可休眠 WebSocket，平台自动回复心跳，避免 SSE 让对象持续活跃。浏览器掉线重连后会补拉，锁屏可靠推送仍不保证。
- 受保护模式的 WebSocket 绑定已验证的会话有效期和认证模式，切换保护方式或更换口令后，旧连接不再接收业务通知。
- 正式域名只使用 `physio.pawpawmaster.com`，不修改根站 `pawpawmaster.com`。默认关闭 workers.dev 和预览网址。

## 0. 当前边界与费用

- 本轮仅准备代码和本地验证，**没有 Cloudflare 登录授权时不会修改 DNS 或发布站点**。不要把 API Token、登录 Cookie 或密码发到聊天/仓库。
- 使用前在 Cloudflare 控制台确认账户计划支持 SQLite Durable Objects，并检查 Workers/DO 的配额与费用。超额是否停用或收费取决于账户套餐；部署脚本不会替你升级付费计划。
- 云版目前将业务数据完整加载进一个对象，设置 **8MB 总业务数据上限、单条患者/模板/每日条目 1MB 上限**。超过会拒绝本次写入，不会截断保存。适合先验证单治疗室；大量多年历史需先调整查询与存储方式，不能直接导入 128MB 的本地档案。
- 自动备份、审计另存 SQLite。保留最近 30 份分钟级备份、最近 30 个有改动日期的日备份和最近 10000 条审计；建议每周再下载一份完整 JSON 到自己保管的存储。SQLite Durable Objects 也提供平台 PITR，但不是机外备份的替代品。
- 患者数据和访问流量会进入 Cloudflare，不再是“仅存治疗室本机”。使用真实健康资料前，需自行确认授权、平台条款、存储区域和适用隐私要求，先用模拟数据验收。

## 1. 可选：切回 Access 邮箱保护

需要邮箱保护时，将构建变量 `AUTH_MODE` 改为 `access`，再执行以下步骤。当前公开演示和共用口令模式无需配置邮箱 Access。

在 Cloudflare Zero Trust / Access 控制台：

1. 创建 **Self-hosted** 应用，名称例如「治疗室派工」。
2. 保护主机名 **`physio.pawpawmaster.com` 的所有路径**，不能排除 `/api/*`、`/api/events`、导入导出或模型资源。
3. 创建 **Allow** 策略，只允许治疗室实际工作人员的指定邮箱或受控身份组。可以使用邮件一次性验证码；不要配置 Everyone 或 Bypass。
4. 记下团队域名，例如 `你的团队.cloudflareaccess.com`。
5. 从应用详情复制 **Application Audience（AUD）**。

团队域名和 AUD 是公开配置标识，不是 API 密钥。Worker 逐次校验 JWT 签名、签发者、AUD、有效期与用户邮箱；缺配置返回 503，未登录或伪造凭证返回 401，静态资源也不能绕过。

Access 只控制谁能进入治疗室，内部仍沿用原来的共用员工名单，**没有岗位权限分级**。审计额外记录 Access 登录邮箱，不能把选择某个名字当作该人的独立身份认证。

## 2A. 从本机发布

需要 Node.js 22、Cloudflare 账户对该域名和 Workers 的部署权限。

```bash
npm ci
npx wrangler login
```

`wrangler login` 会通过浏览器授权，请在自己的电脑完成，不要复制登录凭证到聊天。

当前公开演示直接执行：

```bash
npm run cf:deploy
```

以后切回 Access 时设置公开配置并部署：

```bash
export ACCESS_TEAM_DOMAIN='你的团队.cloudflareaccess.com'
export ACCESS_AUD='Access 应用的 AUD'
export AUTH_MODE='access'
npm run cf:deploy
```

部署脚本会先检查配置、构建前端，再通过 Wrangler 发布 Worker、静态资源及 SQLite Durable Object，并申请子域名路由。域名必须已经在当前 Cloudflare 账户中处于 Active 状态。

脚本不会自动创建或放宽外层 Access 策略；它只发布选定的认证模式。受保护模式缺少其配置时仍拒绝访问，只有明确选择并确认的公开演示才无需登录。

**不要在正式部署时使用 `--env local`，不要改变 `CLINIC_ID`、`ClinicRoom` 类名或删除 `v1` migration。** 它们决定原有数据库的寻址和生命周期，更换会看起来像新建了一间空治疗室。

## 2B. 连接 GitHub 自动构建（无需把密钥放进代码）

也可以在 Cloudflare **Workers & Pages** 中选择从 Git 仓库导入，选择：

- 私有仓库：`PawpawFLX-Ten/physio-dispatch`
- Worker 项目名称：`physio-dispatch`（与部署配置一致）
- 分支：`main`
- 项目类型：**Worker，不是 Pages 静态站点**
- 构建命令：`npm run build`
- 部署命令：`npm run cf:deploy`（会再核对选定的认证模式并构建一次）
- 当前公开演示无需 Access 构建变量；切回邮箱模式时才设置 `AUTH_MODE=access`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`
- Node.js：22 或平台支持的更高 LTS

按控制台提示授权它读取这个私有仓库。Workers Builds 使用平台提供的部署凭据，不要把凭据写入 `wrangler.json` 或 GitHub 源码。没有授权时，本地工具无法代替你完成这一步。

## 3. 第一次使用与旧数据迁移

1. 在手机系统浏览器打开 `https://physio.pawpawmaster.com`；公开演示直接进入，共用口令/Access 模式才需要对应验证，再建立或选择员工名字。
2. 先用模拟患者验证两台手机实时同步、按顺序完成、设备互斥、锁屏返回和问题反馈。
3. 如需迁移本地档案：先在本地版设置里导出 JSON，再在云端设置里导入。**导入会替换整间云端治疗室数据**，不是合并；旧本地电脑上的数据不会自动上传或同步。
4. 云端设置可查看、下载和恢复云备份。恢复前如果别人又改单，系统会拒绝恢复并要求刷新列表。
5. 以后各手机都使用这个 HTTPS 域名；不要继续混用旧局域网地址，二者是两份独立数据。

微信内置浏览器的受保护登录跳转、口令 Cookie 及文件下载必须用实际机型验证。下载备份不成功时使用系统浏览器；受保护会话过期后刷新页面重新验证。

## 4. 本地验证，不操作云账户

```bash
npm test
npm run cf:build
npm run test:cloudflare
```

- `cf:build` 只构建并执行 Wrangler dry-run，不发布。
- `test:cloudflare` 启动本地 workerd、临时 SQLite 和两台模拟手机，验证 Access 拒绝匿名、共用口令登录、显式公开演示、事务持久化、WebSocket、重启恢复及备份；不使用真实患者数据或 Cloudflare 账户。
- 手工开发：先 `npm run build`，再 `npm run cf:dev`；只绑定 `127.0.0.1`，仅本地环境允许跳过 Access。

## 排障

| 现象 | 检查 |
| --- | --- |
| 已切公开演示仍出现邮箱页 | 这是外层 Access，push 不会删除它；只移除/Bypass 本子域名的应用，并检查构建变量是否仍覆盖成 access |
| 口令模式 503 | Worker Secret `CLINIC_PASSCODE` 是否已设置为 16～256 字符；不要把口令当构建公开变量 |
| 503「尚未配置 Access」 | 是否通过 `cf:deploy` 传入团队域名和 AUD，二者是否对应当前应用 |
| 401 / 页面要求重新验证 | Access 登录是否过期、应用 AUD 是否匹配、所有路径是否受保护 |
| Worker 部署成功但域名打不开 | 域名所在账户/Active 状态、自定义域名证书及已有 DNS 冲突；不要改动根域名站点 |
| 本机显示空单，云端也显示另一份 | 本地与云端是独立数据，请确认地址，不要误做导入覆盖 |
| 数据超限拒绝保存 | 先导出，联系维护者拆分/归档历史；不要调大到超过 Workers 内存后强行使用 |
| 设备锁或完成状态不对 | 不要清空数据库；先导出并检查审计、备份，必要时恢复 |

官方参考：[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[验证 Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[静态资源 Worker-first](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)。
