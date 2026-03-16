# Antigravity Pulse

**Antigravity Pulse** 是Antigravity的实时资源监控插件。在[Antigravity Context Window Monitor](https://github.com/lalalavir/Antigravity-Context-Window-Monitor)的基础上，新增 **5 小时滚动窗口分析**，帮助你实时掌握各配额组的用量节奏。

## 功能

- **实时上下文监控** — 状态栏显示当前会话的 token 用量、使用率、等效 API 费用
- **5 小时窗口追踪** — 按配额组 (Gemini Pro / Flash / Claude-GPT) 独立追踪用量
- **窗口倒计时** — 状态栏显示当前最活跃窗口的剩余时间
- **用量报告** — Webview 面板展示 7 天汇总 + 窗口历史
- **压缩检测** — 自动检测并标注上下文压缩事件

## 配额组

| 组           | 模型                                        |
| ------------ | ------------------------------------------- |
| Gemini Pro   | Gemini 3.1 Pro (High/Low)                   |
| Gemini Flash | Gemini 3 Flash                              |
| Claude + GPT | Claude 4.6 Sonnet, Claude 4.6 Opus, GPT-OSS |

## 配置

| Key                       | Default       | 说明                          |
| ------------------------- | ------------- | ----------------------------- |
| `agp.pollingInterval`     | `5`           | 轮询间隔（秒）                |
| `agp.windowDurationHours` | `5`           | 配额窗口时长（小时）          |
| `agp.contextLimits`       | _(per model)_ | 各模型上下文窗口上限（token） |

## 命令

- `AG Pulse: Show Report` — 打开用量报告面板
- `AG Pulse: Show Details` — Quick Pick 详情面板
- `AG Pulse: Refresh` — 手动刷新

## 对话导出

AGP 可以将 Antigravity 的对话数据导出为 JSON 文件，供 Web 分析工具使用。

### 前提条件

> [!IMPORTANT]
> 导出功能需要 Antigravity Language Server (LS) 正在运行。你必须有一个**当前打开的 VS Code 窗口**且 Antigravity 处于活动状态。

### 导出命令

```bash
# 导出当前活跃的对话（需要在 VS Code 中有打开的对话）
pnpm export

# 导出所有对话（当前工作区中的全部历史对话）
pnpm export-all
```

导出的 JSON 文件保存在 `.agp/exports/` 目录下。

### 注意事项

- 只有通过 `pnpm export` 导出的 JSON 文件才能被分析工具识别
- 暂不支持直接解析 Antigravity 的原始对话数据
- 导出的 JSON 包含对话内容、token 用量、checkpoint 数据等
- 所有数据处理均在本地完成

## Web 分析工具

AGP 提供三个独立的 Web 分析工具，可在浏览器中本地运行。

> 在线访问：`https://kirenath.github.io/Antigravity-Pulse/tools/`  
> 或直接在浏览器中打开 `tools/index.html`

### 📖 [Conversation Viewer](tools/conversation-viewer.html)

对话内容阅读器 — 拖入导出 JSON，可视化阅读对话内容。

- Markdown 渲染 + 代码语法高亮
- AI 推理过程 / 工具调用折叠面板
- 全文搜索和消息类型筛选
- **导出精简 JSON** — 去掉 checkpoint、token 等元数据，只保留对话内容
- **导出 Markdown** — 生成适合存档的 `.md` 文件

### 💰 [Cost Calculator](tools/cost-calculator.html)

批量成本概览 — 支持多文件拖入，一眼看总花费。

- 对比三种计价方式：无缓存 API / 有缓存 API / AGP 估算
- 可视化成本对比条形图
- 上下文压缩检测
- 每轮对话的 token 消耗详情

### 🔬 [Token Analyzer](tools/token-analyzer.html)

逐条消息深入分析 — 不依赖 Checkpoint，直接从对话文本估算 token。

- 每轮 AI 回复的 Input/Output token 拆解
- 工具路由分类（Read/Write/Other）及颜色标注
- What-If 分析：切换主模型、工具路由模式、缓存模式
- Context 增长曲线图

## 致谢 / Acknowledgements

本项目参考了以下优秀开源项目：

| 项目                                                                                                  | 作者                                      | 说明                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| [Antigravity Context Window Monitor](https://github.com/lalalavir/Antigravity-Context-Window-Monitor) | [lalalavir](https://github.com/lalalavir) | 上下文窗口监控核心逻辑     |
| [Antigravity Cockpit](https://github.com/jlcodes99/vscode-antigravity-cockpit)                        | [jlcodes](https://github.com/jlcodes99)   | 配额组定义与仪表盘设计参考 |
| [ccusage](https://github.com/ryoppippi/ccusage)                                                       | [ryoppippi](https://github.com/ryoppippi) | CLI 用量分析工具设计参考   |

## License

MIT

## 免责声明 / Disclaimer

- 本插件通过分析本地 Language Server 数据进行用量估算，**不保证数值与官方完全一致**
- 所有数据处理均在本地完成，不会向任何第三方发送数据
- 本项目为独立的社区工具，与 Antigravity 官方无关
- 仅供个人学习和研究使用，请勿用于商业用途
- 使用本项目即表示您自行承担所有相关风险
