# dsh-web-search-minimax

DSH 的 `ctx.web` 搜索提供方插件，直连 MiniMax coding-plan 搜索接口
（`POST {baseURL}/v1/coding_plan/search`）。

它复用了官方 `minimax-coding-plan-mcp` 的 `web_search` 工具所调用的同一端点，
直接提交查询并返回有机搜索结果，不经过模型中介，因此没有"是否真的在搜索"的合规问题，
延迟约 1 秒。

## 功能

- 以 `minimax-coding-plan` 作为 provider id 注册到 `ctx.web` 搜索提供方。
- 调用 MiniMax coding-plan 直接搜索接口，返回去重后的结果源列表。
- 密钥通过 DSH credentials 服务或环境变量解析，从不硬编码。
- 所有携带凭据的请求拒绝 HTTP 重定向（防止凭据被转发到其它来源）。

## 安装

**已发布到 DSH 插件商店（公网注册表 `https://npmstore.sub.opengm.top`）**：
在 DSH 网页「设置 → 插件市场」搜索 `dsh-web-search-minimax` 一键安装即可，
配置/更新/卸载都由市场管理。

手工安装（与市场安装同目录布局，一般不需要）：

1. 把本仓库复制为版本化目录：
   `profiles/node_modules/dsh-web-search-minimax-<version>/`
2. 在 `profiles/web/cordis.patch.yml` 里加一行 insert：

   ```yaml
   - insert:
       - id: dsh-web-search-minimax
         name: dsh-web-search-minimax-1.2.0
   ```

3. （可选）把 `web` 行的搜索提供方切到 MiniMax，并停掉 DeepSeek 搜索——注意
   这两条是非 insert 覆盖项，要放在 `cordis.patch.yml` 所有 `- insert:` 块**之前**
   （市场的行级解析只按 `- insert:` 切块，放后面会被吞进上一个 insert 块）：

   ```yaml
   - id: web
     config:
       searchProvider: minimax-coding-plan
   - id: web-search-deepseek
     disabled: true
   ```

   DeepSeek 的 `web_search` 走一次模型请求，成本高；MiniMax coding-plan 直接搜索接口
   只花一次廉价搜索，延迟约 1 秒。关闭后 DeepSeek 卡片也会从设置页消失（其设置命名空间
   不再被服务）。

## 配置

**用插件市场的「配置」按钮即可**（该插件没有自带设置卡片）：在「设置 → 插件市场 →
dsh-web-search-minimax → 配置」里写 JSON，例如：

```json
{ "apiKeyEnv": "MINIMAX_CN_API_KEY", "baseURL": "https://api.minimaxi.com" }
```

`apiKeyEnv` 是**凭据引用（credential-ref 宏）**，真实密钥存在 DSH 凭据域
（`~/.dsh/.credentials.yaml`，也可在 Models 页或 `.credentials.yaml` 里写），
配置文件里只存引用名、不存明文。

设置命名空间：`web-search-minimax`。

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `apiKey` | string（secret） | 可选的明文密钥；为空时走凭据解析。 |
| `apiKeyEnv` | string（credential-ref） | 凭据引用，默认 `MINIMAX_CN_API_KEY`。 |
| `baseURL` | string | 接口基地址，默认 `https://api.minimaxi.com`。 |

环境变量：

- `MINIMAX_CN_API_KEY`：MiniMax coding-plan 密钥（`sk-cp-...`）。
- `MINIMAX_SEARCH_BASE_URL`：覆盖接口基地址。

密钥解析优先级：`apiKey`（明文）→ credentials 服务 → 启动环境变量。

## 修复/校验工具（tools/fix-websearch-config.mjs）

把 `cordis.patch.yml` 里的网页搜索配置**确定性**修正为「MiniMax 优先 + DeepSeek 停用」，
并用 DSH 自己的 patch 算法（dsh-app-boot + dsh-base）**自校验**，验证通过才写盘——
不依赖手改 / AI 是否写对。

```bash
# 只检查（不改文件）
node tools/fix-websearch-config.mjs
# 修正并验证后写盘（幂等，可重复跑）
node tools/fix-websearch-config.mjs --write
# 指定文件 / 指定插件版本
node tools/fix-websearch-config.mjs --patch <cordis.patch.yml> --write --version 1.2.0
```

它会：删除无效的 `- disable: web-search-deepseek` 写法（loader 会静默忽略它），
确保 `- id: web`（`config.searchProvider: minimax-coding-plan`）与
`- id: web-search-deepseek`（`disabled: true`）两条覆盖项存在，并保证它们位于所有
`- insert:` 块之前（否则会被插件市场的行级解析吞进 insert 块）。退出码：
`0`=最终状态正确，`1`=不正确（未写盘或验证失败），`2`=运行错误。

## 工作原理

每次搜索：

1. 读取当前配置，解析出密钥与基地址。
2. `POST {baseURL}/v1/coding_plan/search`，请求体 `{ "q": "<query>" }`，
   携带 `Authorization: Bearer <key>`。
3. 解析响应的 `organic` 结果列表，去重后归一化为 `{ sources, truncated }`。

## 历史说明

- **v1.1.0**：曾自带浏览器半边 `lib/client.js`，在「设置 → 插件 → 插件配置」渲染一张
  MiniMax 配置卡片（免 bundle 注入、随版本分发）。后因市场「配置」按钮 + `apiKeyEnv`
  凭据引用宏已能覆盖全部配置且无需明文，该卡片被判定冗余，**v1.2.0 起移除**。
- **v1.0.0 及更早**：`patches/` 下曾有两个给 `@deepseek-ai/dsh-client-ui-settings-plugins`
  发布包打文本补丁的脚本（rc.6/rc.7 时代），也随本次清理一并删除。

## License

MIT