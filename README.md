# 巢 · dsh-nest

> 在**设置 → 会话从属**里用下拉框安排「谁归谁管」，
> 然后母会话就能像访问一个 agent 那样访问子会话：**原地唤醒、投一句话、等它回答**。
> 不复制历史，不搬会话，它还是它自己。

---

## 两半

### 1. 面板：设置 → 会话从属

- 自动列出这台机器上**所有**会话（带标题、创建时间、是否开着），按关系排成树，子会话缩进显示。
- 每一行右边一个**下拉框**选上级 —— 用标题挑，**不用手打任何会话 id**。
- 顶部搜索框按标题/id 过滤；`（无上级）` 就是解除关系。
- 关系存在 `$DSH_HOME/dsh-nest/relations.json`，一条一行，随时改回；面板会拒绝成环（A→B→A）和挂到自己下面。
- 它只决定**谁能访问谁**，不改任何会话的日志/header，也不改 DSH 侧边栏里的会话树。

### 2. 工具：把子会话当 agent 用

```
会话 A（你正在聊的） ──问一句──▶ 会话 B（原样，原地继续）
        ▲                              │
        └────────── 它的回答 ───────────┘
```

- **访问的是 B 本身**：B 的 id、header、历史都不动，新的一轮写进 B 的日志。
- **B 看得出是谁在问**：消息带 `agent-message` 来源（`form: relay`，`senderSessionId` = A）。
- **问完放回去**：B 没开着就临时 `resume`，答完 `dispose`；已经开着就复用那个活 agent。
- **省略 `session` 就是问「我的子会话」**：面板里挂给当前会话的那些，只有一个时直接问，多个时会列出来让你点名。

## 装

已经在 `D:\dsh-mod\dsh-nest` 写好、并装进 `desktop` profile 了。换 profile 时：

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-nest" -Target "D:\dsh-mod\dsh-nest"
# package.json: dependencies 加 "dsh-nest": "link:D:/dsh-mod/dsh-nest"；dsh.profile.bundles 加 "dsh-nest"
```

配置写在 profile 的 `cordis.patch.yml`（`id` 对上 `nest`）：

```yaml
- id: nest
  name: dsh-nest
  config:
    enabled: true
    maxListed: 25
    titleScan: 60
    askTimeoutSeconds: 180
    panelTitleScan: 200
```

> 改这份 patch 会触发宿主热重载，**不用重启**；改插件自己的代码（`lib/`）要重启。
> 改 `client.js` 之后要**刷新一下页面**才会看到新面板。

## 怎么用

1. 打开 **设置 → 会话从属**，找到想当子会话的那条，右边「上级」下拉里选母会话。
2. 回到母会话，说：「问一下你的子会话，它那边测试跑完没有。」

工具：

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `nest_list_sessions` | 列出会话，标出「当前会话 / 子会话 / 开着 / 归在谁下面 / 几个下级」 | `query`、`limit` |
| `nest_ask_session` | 访问会话：投一句话，等它回答，把回答带回来 | `message`、`session`（**可省略**＝问我的子会话）、`wait_seconds` |

返回 `{ sessionId, status, reply, waitedSeconds }`：
`idle` = 答完；`running` = 没等完（它继续跑）；`error` = 它这一轮挂了（`reply` 里就是原因）。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉就不挂工具也不挂面板接口 |
| `maxListed` | `25` | 列会话时最多给模型看几条 |
| `titleScan` | `60` | 按标题搜时最多读多少条标题 |
| `askTimeoutSeconds` | `180` | 默认等多久；`wait_seconds` 可单次覆盖，上限 900 |
| `panelTitleScan` | `200` | 面板一次最多读多少条会话标题 |

## 面板没出现怎么办

客户端插件是**页面加载时**注册的，装完要刷新一次页面（`Ctrl+R`，必要时 `Ctrl+Shift+R`）。

如果刷新后「设置 → 会话从属」还是没有，先看宿主有没有把这份客户端包识别进去：

```
http://127.0.0.1:65133/api/dsh-nest/client-status
```

返回里 `present: true` 说明已经识别、`bundle` 就是它要加载的地址；`present: false` 时带一次
`?reset=1` 再请求一次（会清掉客户端模块的识别缓存并强制重新识别）：

```
http://127.0.0.1:65133/api/dsh-nest/client-status?reset=1
```

**这个坑踩过一次**：插件第一次被加载时 `package.json` 里还没有 `dsh.client`，宿主就把「这个包没有客户端」记进了缓存，
之后即使补上声明也不会重新识别 —— 表现就是工具全在、面板永远不出现。所以改完客户端声明，除了重启宿主，
也可以先用上面那个 `?reset=1` 自救一下。



- **会真的让它跑一轮**：被访问的会话会像收到一条消息那样开工 —— 花它的 token、用它自己的模型和工具、可能真的改文件。
- **不能访问自己，也不能访问自己的上级**（DSH 血缘里的祖先）：会互相等成死锁，直接拒绝。
- **目标已经开着就复用**：消息会插进它当前的对话里（有意的）。
- **目标在别的进程里开着时唤不醒**：`resume` 失败会明确报「唤不醒」。
- **超时不掐断它**：返回 `running` 后它继续跑，跑完自动放回去；这期间它被占着。
- **回答 = 这一问之后最后一条带文字的助手消息**；只有工具调用的那几步不算。
- **关系表是逻辑的**：面板里的从属不会让它在 DSH 的会话树里变成子节点（那得重写会话日志头，风险高，没做）。

## 实现

```
设置面板 (client.js)
   └─ GET/POST /api/dsh-nest/relations  ──▶  $DSH_HOME/dsh-nest/relations.json

nest_ask_session
   ├─ 省略 session → 关系表里「我的下级」（唯一才自动用）
   ├─ ctx.agents.get(id) 已经开着？直接复用
   │     否则 readSession() 取它上次的 provider/model → ctx.agents.resume({ agentOptions })
   ├─ agent.followup({ role:'user', source:{kind:'agent-message', form:'relay', senderSessionId } })
   ├─ 等它开工（seq 前进 / status=running）→ 再 whenIdle() 与超时赛跑
   └─ 读它日志里「这一问之后」的最后一条助手文字；没文字就取 turn/end 的失败原因
```

几个踩过的坑，都写进代码注释和测试里了：

1. **`import { createUserMessage } from '@deepseek-ai/dsh-llm'` 会让插件在宿主里加载失败**
   （那个包在插件侧解析不到，整条 entry 挂掉、所有工具消失）。改成手搓 UserMessage。
2. **刚投完消息直接 `whenIdle()` 会立刻返回**，拿到空回答 —— 得先等它真的开工。
3. **唤醒"本身是子智能体"的会话**时，第一轮会报 `prompt variable "{{model}}" has no value`；
   把会话日志里最后一次 `request/header` 的 provider/model 当 `agentOptions` 传进去就好了。
4. **唤醒失败/这一轮报错要带出原因**，否则调用方只看到一个空字符串。

## 测试

```powershell
node --test test/client.test.mjs test/core.test.mjs test/plugin.test.mjs test/relations.test.mjs
```

40 条：关系表的读写/坏文件/成环、面板接口（GET/POST/403）、client bundle 自注册与面板挂载、
目标匹配与歧义、血缘防环、回答提取、错误原因提取、注册/卸载、冷会话唤醒+路由+归还、
已开着复用、消息来源、超时不掐断、省略 session 走面板关系、多子会话点名。

## 许可

MIT
