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
