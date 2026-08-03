# 快速开始

[English](quick-start.md)

请先完成[安装](install.zh-CN.md)中的任意一种方式。

## 桌面端

1. 启动 Friday，在**设置 > 模型**中配置一个模型供应商。
2. 可以直接新建个人会话，也可以点击 Project 旁的 **+** 添加项目。
3. 还可以把任意目录拖入 Friday 窗口，直接将它作为受管理的项目打开。
4. 新建或选择一个会话，然后输入任务。

例如：

```text
总结这个项目，并告诉我如何运行测试。
```

项目和会话会持久保存并彼此隔离。关闭项目只会将它从侧边栏移除，不会删除原目录或已保存的会话。模型、联网搜索、界面语言和用户偏好都可以在设置中管理。

## CLI 与 TUI

进入任意项目并启动 Friday：

```powershell
cd path\to\your-project
friday
```

启动目录会成为当前工作区。使用 `/help` 查看交互命令，按 `Ctrl+O` 展开或折叠工具调用详情。

项目初始化是可选的：

```powershell
friday init
```

该命令会创建 `AGENTS.md`，用于记录项目命令和工作约定。Runtime 状态统一保存在 `~/.friday/projects/`，打开项目不会在原目录中创建 `.friday/`。

## 单次调用与普通终端对话

不进入 TUI，直接完成一次请求：

```powershell
friday ask "总结这个项目"
```

使用纯终端对话：

```powershell
friday chat
```

桌面端、CLI 和 TUI 共用相同的 Turn、上下文、记忆、验证、审批、会话和 Trace 实现。

## 常用 CLI 流程

运行带验证的 Goal Loop：

```powershell
friday goal "修复失败的测试并验证它通过"
```

恢复会话或撤回最近一次执行：

```powershell
friday resume --list
friday resume --session <id>
friday undo
```

查看上下文、Skill 或记忆：

```powershell
friday context
friday compact
friday skill list --json
friday memory status
```

批准或拒绝危险命令：

```powershell
friday approve
friday approve --for-session
friday reject
friday reject --message "换一种方式"
```

项目状态保存在 `~/.friday/projects/<workspace-id>/`。全局配置、模型凭据、用户档案、记忆、规则和用户 Skill 位于 `~/.friday/`。
