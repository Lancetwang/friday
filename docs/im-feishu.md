# Phone Bridge (Feishu)

Friday keeps running on your computer and your phone is only a client. The bridge dials out to Feishu over a WebSocket long connection, so no public IP, domain, certificate, or tunnel is involved.

Phone and desktop do not share a conversation. Each Feishu chat gets its own Friday session, and the desktop keeps the session you were already using. The switch below decides whether the phone can reach this workspace at all, not which conversation it lands in.

They do share the workspace, though, so a phone conversation appears in the desktop sidebar under Phone, a few seconds after the turn finishes. Opening one there loads its history and continues it on this machine; the phone picks up those turns the next time it writes to that chat. Both sides read and write the same files, so the only thing to avoid is driving one conversation from both places at the same moment.

## Turn it on

Settings has a Phone section:

1. Paste the App ID and App Secret from your Feishu custom app, then save.
2. Turn the switch on. The bridge starts as a child process of Friday, so closing Friday takes the phone offline again.
3. Send the bot a message from your phone.

The TUI has the same switch as `/phone`, `/phone on`, and `/phone off`.

The switch reflects the process, not the click: if Feishu rejects the credentials the bridge exits and the switch falls back to off with the reason underneath it.

### The SDK it needs

The bridge talks to Feishu through the `lark-oapi` SDK, which is not part of what Friday installs by default.

| How you run Friday | What to do |
| --- | --- |
| Installed desktop app | Nothing; the SDK is built into it |
| Source checkout | `uv sync --extra feishu` |
| `pip install friday-agent` | `pip install "friday-agent[feishu]"` |

Turning the switch on without the SDK stops the bridge and says so under the switch, rather than failing quietly.

## Feishu setup

Long connections are available to a custom app inside your own tenant, not to a marketplace app.

1. Create a custom app in the [developer console](https://open.feishu.cn/app) and copy its App ID and App Secret.
2. Enable the bot capability.
3. Grant the `im:message` and `im:message:send_as_bot` scopes.
4. Subscribe to the `im.message.receive_v1` event.
5. Under Events & Callbacks, choose to receive events over a long connection. Turn the bridge on first: Feishu only saves that choice while a client is connected.

Common setup failures: a trailing space in the App Secret, scopes not yet approved, the app version never published, the bot capability left off, or saving the long-connection choice while the bridge is off.

## Find your own open_id

Until an account is listed, every message is refused. That is deliberate: Friday runs shell commands, so an open bridge would hand every Feishu user a shell on this machine.

Turn the bridge on with an empty list, send the bot one message, and read the bridge output under the switch. It prints the refused `open_id` once per sender. Copy that id into the allowed accounts, save, then switch the bridge off and on.

Group chats stay refused until you enable them, and even then a message must mention the bot and come from a listed sender.

## What a turn looks like on the phone

| Signal | Meaning |
| --- | --- |
| An eye reaction on your message | The bridge accepted it and started working |
| A card that grows as text arrives | The answer streaming in, with the running tool named above it |
| A check reaction | The turn finished |
| A cross reaction | The turn failed |

Short answers arrive as one card rather than opening a streaming one.

## Chat commands

| Message | Effect |
| --- | --- |
| any text | Run a normal turn in this chat's session |
| `/goal <text>` | Run the verified goal loop |
| `/new` | Start a fresh conversation for this chat |
| `/cancel` | Stop the running turn |
| `/status` | Show workspace, model, permission mode, and objective |
| `/help` | List these commands |

The chat-to-session mapping lives in the project state directory, so a chat resumes its own conversation after a restart. It is also what the desktop sidebar reads to tell a phone conversation from a desktop one. Turns run one at a time because the bridge holds a single selected session; `/cancel` bypasses that queue so a stuck turn can always be stopped.

## Approvals

A dangerous command suspends the turn, and the bridge reports the command and its reason. Reply `y` to run it, `n` to refuse, or send any other text as an instruction for what to do instead. Approval state is per chat, so an approval in one conversation cannot execute another conversation's command.

## Run it from a terminal instead

The bridge is also a command, which is useful for a headless machine or a second workspace:

```powershell
uv pip install "friday-agent[feishu]"
friday feishu
```

The desktop switch runs this same command as a child process, so a failure you can reproduce here is the same failure the switch reports.

It reads the same saved settings. Environment variables override them, so one terminal can point at a different app without changing what the settings screen shows:

| Variable | Meaning |
| --- | --- |
| `FRIDAY_FEISHU_APP_ID` | Custom app ID |
| `FRIDAY_FEISHU_APP_SECRET` | Custom app secret |
| `FRIDAY_FEISHU_ALLOWED_USERS` | Comma-separated `open_id` allowlist |
| `FRIDAY_FEISHU_ALLOW_GROUP` | Set to `1` to answer group chats that mention the bot |

## Check the bridge without Feishu

Console mode drives the same sessions, approvals, commands, and progress from your terminal, so a failure here is a Friday problem rather than a Feishu one.

```powershell
friday feishu --console
```

| Send | Expect |
| --- | --- |
| `/status` | Workspace, model, permission mode, session id |
| `hello` | A normal answer |
| `create notes.txt with one line` | The file appears in the workspace |
| a command needing approval | The command, its reason, and a prompt to reply `y` or `n` |
| `y` | The command runs and Friday continues |
| `/new` | A fresh conversation |
| a long task, then `/cancel` | Progress notices, then `Cancelled.` |

## Safety

Friday can run shell commands, so the bridge is a remote execution path into this machine. Keep `manual` permissions, keep the allowlist to yourself, and treat a lost Feishu account as a compromised machine. The app secret is stored with owner-only permissions and is never sent back to the interface that saved it. Feishu credentials are also withheld from the tool subprocesses Friday spawns.
