# Antigravity Pulse

**Antigravity Pulse (AGP)** 是 Antigravity 的对话分析 & 资源监控脚本工具集。拉取到本地任意位置后直接运行，通过读取本机的 Antigravity Language Server 数据来导出对话、分析 token 消耗和估算 API 成本。

## 快速开始

```bash
# 拉取到任意位置
git clone https://github.com/kirenath/Antigravity-Pulse.git
cd Antigravity-Pulse

# 安装依赖（任选其一）
npm install
# 或 pnpm install
# 或 yarn install
```

> [!CAUTION]
> **安全提示：** 导出的对话数据保存在目标工作区的 `.agp/` 目录下，包含完整的对话内容。请务必将 `.agp/` 添加到该工作区的 `.gitignore`，否则对话内容可能会被意外提交到 Git 仓库中泄露！
>
> ```bash
> echo ".agp/" >> .gitignore
> ```

## 对话导出

AGP 作为独立脚本使用——你不需要把 AGP 安装到目标项目里，只需在 AGP 目录下运行命令，并指定要导出对话的 Antigravity 工作区路径。

> [!IMPORTANT]
> 导出时 Antigravity 必须正在运行（即你有一个打开的 Antigravity 窗口且该工作区处于活动状态）。

```bash
# 导出指定工作区的对话（交互式选择）
npm run export -- C:\path\to\your\workspace

# 导出指定工作区的所有对话
npm run export-all -- C:\path\to\your\workspace
```

如果不传路径参数，则默认导出 AGP 安装目录自身的工作区对话：

```bash
# 不传路径 = 导出 AGP 自身目录的对话
npm run export
```

> [!TIP]
> pnpm 用户可以用更简短的写法：`pnpm export C:\path\to\workspace` 或者 `pnpm export-all C:\path\to\workspace`

导出的 JSON 文件保存在 `<目标工作区>/.agp/exports/` 目录下。

- 只有通过 `pnpm export` 导出的 JSON 文件才能被分析工具识别
- 暂不支持直接解析 Antigravity 的原始聊天数据
- 所有数据处理均在本地完成，不会上传

## Web 分析工具

AGP 提供三个独立的 Web 分析工具，可在浏览器中本地运行。

> 在线访问：https://kirenath.github.io/Antigravity-Pulse/tools/  


### 📖 [Conversation Viewer](https://kirenath.github.io/Antigravity-Pulse/tools/conversation-viewer.html)

对话内容阅读器 — 拖入导出 JSON，可视化阅读对话内容。

- Markdown 渲染 + 代码语法高亮
- AI 推理过程 / 工具调用折叠面板
- 全文搜索和消息类型筛选
- **导出精简 JSON** — 去掉 checkpoint、token 等元数据，只保留对话内容
- **导出 Markdown** — 生成适合存档的 `.md` 文件

### 💰 [Cost Calculator](https://kirenath.github.io/Antigravity-Pulse/tools/cost-calculator.html)

批量成本概览 — 支持多文件拖入，一眼看总花费。

- 对比三种计价方式：无缓存 API / 有缓存 API / AGP 估算
- 可视化成本对比条形图
- 上下文压缩检测
- 每轮对话的 token 消耗详情

### 🔬 [Token Analyzer](https://kirenath.github.io/Antigravity-Pulse/tools/token-analyzer.html)

逐条消息深入分析 — 不依赖 Checkpoint，直接从对话文本估算 token。

- 每轮 AI 回复的 Input/Output token 拆解
- 工具路由分类（Read/Write/Other）及颜色标注
- What-If 分析：切换主模型、工具路由模式、缓存模式
- Context 增长曲线图

## 实时监控（可选）

AGP 也可以作为实时 quota 监控脚本运行：

```bash
# 监控指定工作区的 quota 消耗
npm run monitor -- C:\path\to\your\workspace

# 不传路径则监控当前目录
npm run monitor
```

### 配额组

| 组           | 模型                                        |
| ------------ | ------------------------------------------- |
| Gemini Pro   | Gemini 3.1 Pro (High/Low)                   |
| Gemini Flash | Gemini 3 Flash                              |
| Claude + GPT | Claude 4.6 Sonnet, Claude 4.6 Opus, GPT-OSS |

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

- 本工具通过分析本地 Language Server 数据进行用量估算，**不保证数值与官方完全一致**
- 所有数据处理均在本地完成，不会向任何第三方发送数据
- 本项目为独立的社区工具，与 Antigravity 官方无关
- 仅供个人学习和研究使用，请勿用于商业用途
- 使用本项目即表示您自行承担所有相关风险
