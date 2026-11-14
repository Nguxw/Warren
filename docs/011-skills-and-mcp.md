# 011 技能与 MCP

内置工具之外，Warren 还可以借助两种扩展：**技能**提供做某类工作的方法，**MCP 服务器**提供外部工具。前置阅读：[003 运行时](003-runtime.md)、[005 安全边界](005-security.md)。

两者都在侧栏有自己的页面，修改对之后开始的任务生效。

## 技能

### 格式

采用 Anthropic Agent Skills 的格式，现有的技能可以直接使用。一个技能是一个文件夹：

```
research-report/
├── SKILL.md        # 开头是 front matter，正文是做法
└── template.md     # 其他文件：参考资料、模板、脚本
```

```markdown
---
name: research-report
description: Write a sourced research report in Markdown. Use when asked to research a topic…
---

# Research report
…
```

- `name` 由小写字母、数字和连字符组成；`description` 写清楚它做什么、什么时候用，模型靠这句话判断要不要加载它。
- 仓库里的 `examples/skills/research-report` 是一个完整的例子。

### 安装和管理

- **位置：** 技能放在 `~/.warren/skills/<名称>/`。可以在"技能"页点"添加技能…"选一个文件夹，Warren 会把它复制进来，并且不跟随其中的符号链接；也可以点"打开技能文件夹"手动放入。
- **启用和停用：** 停用的技能记在 `config.json` 的 `skills.disabled` 里。
- **格式错误：** 缺少 `SKILL.md`、名称不合规之类的技能会在页面上显示原因，不会提供给模型。

### 模型怎么用

`packages/tools/src/skills.ts`：

- **渐进披露：** 系统提示词只列出启用的技能的名称和描述，每个技能占一行，没用到的技能几乎不占上下文。
- **加载：** 任务需要某个技能时，模型调用 `load_skill(name)`，拿到 `SKILL.md` 的正文和技能文件的清单。
- **文件放在临时目录：** 技能所在的 `~/.warren` 对沙箱是隐藏的，所以加载时把技能文件夹复制到任务的 scratch（`<scratch>/skills/<名称>/`），模型用 shell 读取参考资料、运行脚本，这些命令都在沙箱里。
- **不扩大权限：** 技能只增加说明和文件，不改变 Grant。`load_skill` 的副作用等级是 `read`，崩溃后可以安全地重新执行。

## MCP 服务器

### 两种连接方式

用官方 TypeScript SDK（`@modelcontextprotocol/sdk`）作为客户端，实现在 `packages/mcp`：

| 方式 | 配置 | 说明 |
|---|---|---|
| 本地命令（stdio） | `command`、`args`、`env` | Warren 启动这个进程，通过标准输入输出通信 |
| 远程地址（HTTP） | `url`、`headers` | streamable HTTP |

`~/.warren/config.json`：

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"]
      },
      "github": {
        "command": "github-mcp-server",
        "args": ["stdio"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$WARREN_GITHUB_TOKEN" },
        "approval": "required"
      },
      "notion": {
        "url": "https://mcp.notion.com/mcp",
        "headers": { "Authorization": "Bearer $WARREN_NOTION_TOKEN" },
        "enabled": false
      }
    }
  }
}
```

服务器名称由小写字母、数字和连字符组成，最多 24 个字符，因为它会成为工具名的一部分。

### 信任和边界

MCP 服务器是你自己选择运行的程序，以你的权限在沙箱之外运行。Warren 把它们的工具当作特权工具对待：

- **副作用等级：**
  - 服务器标为只读（`readOnlyHint`）的工具是 `read`，可以直接调用；
  - 其他工具一律是 `external`，崩溃恢复时从不重新执行，而是告诉模型"结果未知，请先核对"。
- **审批：** 非只读工具的调用默认需要你批准（`approval: "required"`），审批提示写明是哪个服务器的哪个工具、带什么参数；可以按服务器改成 `auto`。
- **Grant：** 任务创建时，把当时启用的服务器写进 Grant 的 `mcpServers`。之后新加或启用的服务器不会出现在已有的任务里。
- **环境变量：** 本地服务器只拿到最小的环境（`PATH`、`HOME`、`USER`、`SHELL` 等），再加上它的配置里写明的变量，不继承守护进程的其他环境变量。
- **密钥引用：** `env` 和 `headers` 的值可以写 `$WARREN_XXX`，启动时从 Warren 的密钥里取值。密钥本身留在 `credentials.env`，不写进配置文件。引用的密钥不存在时，这个服务器连接失败并说明原因。

### 运行

- **连接：** 第一次需要某个服务器的工具时才连接，之后保持连接；配置改变时自动重连。
- **工具名：** 交给模型的工具名是 `mcp__<服务器>__<工具>`（最多 64 个字符），描述前面带上服务器名；参数直接使用服务器给出的 JSON Schema，由服务器自己校验。
- **结果：** 文本原样返回；只有结构化内容时转成 JSON；其他类型的内容只记一个占位说明；超过 5 万个字符截断。服务器返回 `isError` 时结果记为 `error`。
- **出错：** 连不上的服务器在这一轮不提供工具，错误显示在"MCP"页上，任务的其他工具照常可用。单次调用最长 10 分钟，有进度通知时重新计时。
- **测试连接：** "MCP"页的"测试"会重新连接并列出全部工具，标出哪些是只读的。

## 验证

- **`packages/mcp/tests/hub.test.ts`：** 对着一个真实的 stdio MCP 服务器（测试用的 fixture）检查：工具列表和 JSON Schema；只读工具是 `read`、其他是 `external` 并需要审批；服务器只能看到配置的密钥，看不到守护进程的其他环境变量；连接失败时不提供工具并报告原因。
- **`packages/tools/tests/skills.test.ts`：** front matter 的几种写法；安装时不带入符号链接；停用；加载时复制到 scratch；仓库里的示例技能是有效的。
- **`apps/daemon/tests/extensions.test.ts`：** 端到端：
  - 任务调用 MCP 工具，只读工具直接执行，其他工具等待审批，批准后执行；
  - 已有的任务不会拿到后来加的服务器；
  - 技能出现在系统提示词里，加载后的文件位于任务的 scratch，停用后不再提供。
