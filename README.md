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

本机手工安装（与插件市场安装的插件同目录布局）：

1. 把本仓库复制为版本化目录：
   `profiles/node_modules/dsh-web-search-minimax-<version>/`
2. 在 `profiles/web/cordis.patch.yml` 里加一行 insert：

   ```yaml
   - insert:
       - id: web-search-minimax
         name: dsh-web-search-minimax-1.1.0
   ```

3. （可选）把 `web` 行的搜索提供方切到 MiniMax，并停掉 DeepSeek 搜索：

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

4. 重启 DSH 后刷新浏览器：`设置 > 插件 > 插件配置` 会出现「MiniMax 网页搜索」卡片，
   可直接编辑 `baseURL` 与 API Key。

## 配置

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

## 工作原理

每次搜索：

1. 读取当前配置，解析出密钥与基地址。
2. `POST {baseURL}/v1/coding_plan/search`，请求体 `{ "q": "<query>" }`，
   携带 `Authorization: Bearer <key>`。
3. 解析响应的 `organic` 结果列表，去重后归一化为 `{ sources, truncated }`。

## 网页设置卡片

`lib/client.js` 是本插件的浏览器半边（package.json 声明 `dsh.client.platform: "web"`），
它把「MiniMax 网页搜索」卡片注册进 `settings.plugin.item`（key = `web-search-minimax`
命名空间），由 `@deepseek-ai/dsh-client-ui-settings-plugins` 的「插件配置」页渲染。

**不再需要任何 bundle 注入/补丁**：卡片随插件版本化目录一起分发，DSH 更新或 `npx` 重装
只影响发布包本身，只要 patch 行还在，卡片就一直在。卡片与 DeepSeek 卡片同构（少一个
`maxUses` 旋钮，因为 MiniMax 直接搜索接口没有每请求搜索次数上限）。

> `patches/` 下两个脚本是旧版（rc.6/rc.7 时代）给 npx 安装的
> `@deepseek-ai/dsh-client-ui-settings-plugins` 发布包打文本补丁的遗留物。
> 新版本（0.1.1-rc.2+）里插件自带客户端半边后不再需要它们，保留仅为历史参考，
> 请勿再运行（它们会尝试修改发布包文件）。

## License

MIT