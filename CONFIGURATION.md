# dsh-web-search-minimax 配置指南

目标：**让网页搜索走 MiniMax（便宜、直接搜索接口），并停用 DeepSeek 搜索（每次搜索走一次模型请求，成本高）。**

---

## 方法 A：只配置 MiniMax 插件本身（不停用 DeepSeek）

在 DSH 网页「设置 → 插件市场 → dsh-web-search-minimax → 配置」里写 JSON：

```json
{ "apiKeyEnv": "MINIMAX_CN_API_KEY", "baseURL": "https://api.minimaxi.com" }
```

- `apiKeyEnv` 是**凭据引用（credential-ref 宏）**，真实密钥存在 DSH 凭据域
  （`~/.dsh/.credentials.yaml`，也可在「设置 → 模型」页或凭据文件里写），配置文件只存引用名、不存明文。
- 其实 `apiKeyEnv` 就是默认值，只要凭据域里配好了 key，**什么都不写也能用**。
- ⚠️ 方法 A **不会自动停用 DeepSeek**——如果 `web` 行的 `searchProvider` 仍指向 DeepSeek，搜索还是走 DeepSeek。要彻底停用请看方法 B。

---

## 方法 B：停用 DeepSeek 并切到 MiniMax（推荐）

编辑 `cordis.patch.yml`（默认在 `~/.dsh/profiles/web/cordis.patch.yml`，或在 `$DSH_HOME/profiles/web/` 下）。

把下面两段**复制粘贴到文件靠前的位置——所有 `- insert:` 块之前**：

```yaml
# ── 网页搜索：切到 MiniMax，停用 DeepSeek ──
- id: web
  config:
    searchProvider: minimax-coding-plan
- id: web-search-deepseek
  disabled: true
```

保存后 DSH 会热加载生效；浏览器刷新一次即可。

### ⚠️ 三个必守的坑

1. **位置**：这两条必须放在所有 `- insert:` 块**之前**（通常就是紧挨着文件头部注释之后）。
   放在某个 `- insert:` 块后面的话，插件市场的行级解析只按 `- insert:` 切块，会把它们吞进上一个
   insert 块，导致市场里的「配置/卸载」误读误删。检查方法：打开文件看 `- insert:` 之前的区域
   应包含这两条。

2. **不要写 `- disable: web-search-deepseek`**：这种写法 loader 会**静默忽略**（patch 算法只认
   `id` 定位的覆盖项，没有 `id` 的条目直接跳过），DeepSeek 根本没关。正确写法是上面第二段
   `- id: web-search-deepseek` + `disabled: true`。

3. **`- id: web` 的 `config` 会整体替换** `web` 行原来的 config。默认 `web` 行的 config 只有
   `searchProvider`，所以上面写法完整。如果你原来在 `web` 行还配了别的键（如 `fetchProvider`），
   要一起写进去，否则会被覆盖掉。

### 怎么确认生效

- 「设置 → 插件 → 插件配置」里 **DeepSeek 卡片消失** = `web-search-deepseek` 已停用（命名空间不再被服务）。
- 网页搜索返回的结果走 MiniMax（约 1 秒，直接搜索接口，不经过模型）。

---

## 常见问题

- **装了插件但搜索还是 DeepSeek**：没做方法 B 的 `web` 覆盖项，`searchProvider` 仍是默认的 `deepseek-official`。
- **改了 `- disable:` 没反应**：那是无效写法，见坑 2，改回 `- id: web-search-deepseek` + `disabled: true`。
- **市场里点「配置/卸载」行为异常**：多半是覆盖项被放进了 insert 块后面，见坑 1，把两条覆盖项移到所有 `- insert:` 之前。
