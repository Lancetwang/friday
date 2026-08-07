export type Language = 'en' | 'zh'

const LANGUAGE_KEY = 'friday.desktop.language'

export function loadLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    // localStorage unavailable
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let current: Language = loadLanguage()

export function getLanguage(): Language {
  return current
}

export function setLanguage(language: Language) {
  current = language
  try {
    localStorage.setItem(LANGUAGE_KEY, language)
  } catch {
    // localStorage unavailable
  }
  if (typeof document !== 'undefined') document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
}

const en: Record<string, string> = {
  // Chrome & sidebar
  'nav.skills': 'Skills',
  'nav.observability': 'Observability',
  'sidebar.projects': 'Projects',
  'sidebar.recent': 'Recent',
  'sidebar.phone': 'Phone',
  'sidebar.phoneEmpty': 'Nothing from your phone yet',
  'sidebar.addProject': 'Add project',
  'sidebar.newConversation': 'New conversation',
  'sidebar.closeProject': 'Close project',
  'sidebar.search': 'Search conversations',
  'sidebar.empty': 'No saved conversations',
  'sidebar.settings': 'Settings',
  'sidebar.rename': 'Rename',
  'sidebar.delete': 'Delete',
  'sidebar.deleteConfirm': 'Delete "{title}"?',
  'sidebar.renamePrompt': 'Rename conversation',
  'status.working': 'Working',
  'status.apiKeyRequired': 'API key required',
  'status.ready': 'Ready',
  'status.error': 'Unavailable',
  'status.idle': 'No project',
  'status.connecting': 'Connecting',
  'conversation.new': 'New conversation',
  'theme.toDark': 'Switch to dark theme',
  'theme.toLight': 'Switch to light theme',

  // Composer
  'composer.placeholder': 'Ask Friday to do something (Enter to send · Shift+Enter for a new line)',
  'composer.starting': 'Starting Friday…',
  'composer.approvalBlocked': 'Resolve the pending approval first…',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
  'composer.attach': 'Attach image',
  'composer.removeAttachment': 'Remove attachment',
  'composer.configureModels': 'Configure models',
  'composer.model': 'Model',
  'composer.thinking': 'Thinking',
  'permission.title': 'Choose how Friday handles risky commands',
  'permission.manual': 'Request approval',
  'permission.manual.desc': 'Ask before risky actions',
  'permission.auto': 'Let Friday decide',
  'permission.auto.desc': 'Review intent before risky actions',
  'permission.bypass': 'Full access',
  'permission.bypass.desc': 'Run allowed commands without prompts',
  'effort.off': 'Off',
  'effort.off.desc': 'Disable model reasoning',
  'effort.low': 'Low',
  'effort.low.desc': 'Fast, light reasoning',
  'effort.high': 'High',
  'effort.high.desc': 'Balanced deep reasoning',
  'effort.max': 'Max',
  'effort.max.desc': 'Maximum reasoning effort',
  'project.personal': 'Personal conversations',
  'composer.working': 'Friday is working',
  'composer.visionRequired': 'Select a vision-capable model before attaching an image.',
  'modelMenu.keyConfigured': 'API key configured',
  'modelMenu.keyRequired': 'API key required',

  // Welcome
  'welcome.greeting.morning': 'Good morning',
  'welcome.greeting.afternoon': 'Good afternoon',
  'welcome.greeting.evening': 'Good evening',
  'welcome.greeting.late': "It's late",
  'welcome.greeting.format': '{greeting}, {hint}',
  'welcome.0': 'Where shall we start today?',
  'welcome.1': 'What can I help you with today?',
  'welcome.2': 'Start with an idea.',
  'welcome.3': 'Is there something you would like to get done?',
  'welcome.4': "I'm ready when you are.",
  'welcome.5': "Let's make something useful.",

  // Approval panel
  'approval.title': 'Approval required',
  'approval.pendingCommand': 'Pending command',
  'approval.once': 'Approve once',
  'approval.session': 'Allow for session',
  'approval.reject': 'Reject',
  'approval.guidance': 'Tell Friday what to do instead…',
  'approval.send': 'Send',

  // Verification
  'verification.pass': 'Verified',
  'verification.error': 'Verification error',
  'verification.blocked': 'Verification blocked',
  'verification.inconclusive': 'Verification inconclusive',
  'verification.failed': 'Verification failed',
  'verification.pending': 'Verifying the result…',
  'verification.continuing': 'Continuing with verification feedback…',

  // Context compaction
  'context.compacted': 'Context compacted ({before} → {after} tokens). The model now reads a summary of the earlier work plus the last {turns} steps in full. Everything above stays in this conversation.',
  'context.compactedPlain': 'Context compacted. The model now reads a summary of the earlier work; everything above stays in this conversation.',
  'context.compactedLocal': 'Friday wrote the summary itself because the model was unavailable.',
  'context.trimmed': 'Context trimmed: {count} tool results shortened. Full output is still on disk.',
  'context.compactFailed': 'Context compaction failed ({reason}). This conversation may reach the model limit.',

  // A project that disappeared from disk. Removing it silently looks like a bug.
  'project.missing': 'Removed "{name}" from the sidebar: its folder no longer exists. Add it again if it comes back.',

  // Why a turn ended early. Without this a guard stop reads as a normal answer.
  'stop.noProgress': 'Friday stopped early: the same step kept producing the same result. The answer above is what it had.',
  'stop.contextWindow': 'Friday stopped early: the context window is full and compaction could not free enough of it.',

  // Turn metrics. The window figure is how full the context is; the cost figure
  // is the sum over every request in the turn, which runs far ahead of it.
  'metrics.window': 'context {used}/{total} ({percent})',
  'metrics.request': '1 request',
  'metrics.requests': '{count} requests',
  'metrics.cost': 'in {input} ({cached} cached) / out {output}',
  'metrics.explain':
    'Context is how full the conversation is now. The token counts are totals over every request this turn made, each one re-sending the conversation, so they run ahead of the context figure; the cached part was served from the provider\'s prefix cache and billed at a fraction of fresh input.',

  // Thinking
  'thinking.running': 'Thinking',
  'thinking.done': 'Thought for {duration}',
  'thinking.interrupted': 'Thinking interrupted · {duration}',
  'thinking.runningWith': 'Thinking… {duration}',

  // Tools
  'tool.bash.verb': 'run command',
  'tool.bash.doing': 'Running command',
  'tool.bash.did': 'Ran command',
  'tool.bash.doingMulti': 'Running multiple commands',
  'tool.bash.didMulti': 'Ran multiple commands',
  'tool.websearch.verb': 'search the web',
  'tool.websearch.doing': 'Searching the web',
  'tool.websearch.did': 'Searched the web',
  'tool.websearch.doingMulti': 'Searching the web repeatedly',
  'tool.websearch.didMulti': 'Searched the web multiple times',
  'tool.webfetch.verb': 'read web page',
  'tool.webfetch.doing': 'Reading web page',
  'tool.webfetch.did': 'Read web page',
  'tool.webfetch.doingMulti': 'Reading multiple pages',
  'tool.webfetch.didMulti': 'Read multiple pages',
  'tool.read.verb': 'read file',
  'tool.read.doing': 'Reading file',
  'tool.read.did': 'Read file',
  'tool.read.doingMulti': 'Reading multiple files',
  'tool.read.didMulti': 'Read multiple files',
  'tool.write.verb': 'edit file',
  'tool.write.doing': 'Editing file',
  'tool.write.did': 'Edited file',
  'tool.write.doingMulti': 'Editing multiple files',
  'tool.write.didMulti': 'Edited multiple files',
  'tool.find.verb': 'find files',
  'tool.find.doing': 'Finding files',
  'tool.find.did': 'Found files',
  'tool.find.doingMulti': 'Finding files repeatedly',
  'tool.find.didMulti': 'Found files multiple times',
  'tool.plan.verb': 'update plan',
  'tool.plan.doing': 'Updating plan',
  'tool.plan.did': 'Updated plan',
  'tool.plan.doingMulti': 'Updating plan repeatedly',
  'tool.plan.didMulti': 'Updated plan multiple times',
  'tool.generic.verb': 'use tool',
  'tool.generic.doing': 'Using tool',
  'tool.generic.did': 'Used tool',
  'tool.generic.doingMulti': 'Using tools repeatedly',
  'tool.generic.didMulti': 'Used multiple tools',
  'activity.approval': 'Waiting for approval: {verb}',
  'activity.error': 'Problem while {doing}',
  'activity.approvalMulti': 'Waiting for approval: multiple actions',
  'activity.errorMulti': 'Some actions failed',

  // Sources
  'sources.label': '{count} pages referenced',
  'sources.aria': '{count} pages referenced',
  'sources.trigger': 'Sources',

  // Fork map
  'fork.show': 'Show branch map',
  'fork.hide': 'Hide branch map',
  'fork.main': 'Main session',
  'fork.fork': 'Fork session',
  'fork.from': 'Forked from "{title}"',
  'fork.open': 'Open',
  'fork.delete': 'Delete',

  // Artifacts
  'artifact.image': 'Image',
  'artifact.markdown': 'Markdown',
  'artifact.pdf': 'PDF',
  'artifact.text': 'Text',

  // Skills browser
  'skills.search': 'Search skills…',
  'skills.tagline': 'Reusable workflows available to Friday',
  'skills.installed': 'Installed',
  'skills.empty': 'No matching skills',
  'skills.close': 'Close',
  'skills.back': 'Back',

  // Settings shared
  'settings.back': 'Back',
  'settings.loading': 'Loading settings…',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saved': 'Saved.',
  'badge.configured': 'Configured',
  'badge.unconfigured': 'Not configured',
  'secret.show': 'Show',
  'secret.hide': 'Hide',

  // Settings nav
  'settings.general': 'General',
  'settings.general.hint': 'Language and preferences',
  'settings.models': 'Models',
  'settings.models.hint': 'Providers and API keys',
  'settings.web': 'Web Search',
  'settings.web.hint': 'Tavily and AnySearch',
  'settings.phone': 'Phone',
  'settings.phone.hint': 'Drive this workspace from Feishu',
  'settings.memory': 'Memory',
  'settings.memory.hint': 'Persistent memory files',
  'settings.docs': 'Docs',
  'settings.docs.hint': 'Getting started',

  // Phone bridge
  'phone.title': 'Phone',
  'phone.desc': 'Send work to this workspace from Feishu on your phone. Phone and desktop keep their own conversations.',
  'phone.on': 'Reachable from your phone',
  'phone.onHint': 'Messages from allowed accounts run here. Closing Friday takes it offline.',
  'phone.off': 'Not reachable',
  'phone.offHint': 'Turn this on to accept messages from Feishu.',
  'phone.needsSetup': 'Add an app id and app secret first.',
  'phone.start': 'Turn on',
  'phone.stop': 'Turn off',
  'phone.appId': 'App ID',
  'phone.appIdHint': 'cli_...',
  'phone.appSecret': 'App secret',
  'phone.removeSecret': 'Remove the saved secret',
  'phone.removeSecretArmed': 'The secret will be removed on save',
  'phone.allowedUsers': 'Allowed accounts',
  'phone.allowedUsersPlaceholder': 'ou_...',
  'phone.allowedUsersHint': 'One Feishu open_id per line. Anyone not listed is refused.',
  'phone.pairing': 'No account is allowed yet, so every message is refused. Turn the bridge on, send it one message, then copy the open_id from the log below into the list above.',
  'phone.groupOn': 'Group chats allowed, mention required',
  'phone.groupOff': 'Group chats refused',
  'phone.log': 'Bridge output',
  'phone.saved': 'Saved. Turn the bridge off and on to apply it.',

  // General
  'general.title': 'General',
  'general.desc': 'Preferences for this device.',
  'general.uiLanguage': 'Interface language',
  'general.uiLanguageNote': 'Changes the desktop interface only, not the language Friday uses to answer.',
  'general.profileNote': 'These preferences update your user profile and change how Friday addresses and responds to you.',
  'general.name': 'Your name',
  'general.namePlaceholder': 'How should Friday address you?',
  'general.responseLanguage': 'Friday response language',
  'general.responseLanguagePlaceholder': 'For example: Chinese',

  // Models
  'models.title': 'Models',
  'models.desc': 'Known providers only need an API key — Friday discovers their models. For any other OpenAI-compatible service, add it below.',
  'models.inUse': 'In use',
  'models.builtinHint': 'Models are discovered automatically when you save the key.',
  'models.discoveredCount': '{n} models available — pick one from the model menu in the chat input.',
  'models.customHint': 'Any service that speaks the OpenAI chat API: add its base URL, model id, and API key.',
  'models.addCustom': 'Add OpenAI-compatible endpoint',
  'models.addCustomHint': 'Base URL and API key are yours to fill in',
  'models.name': 'Name',
  'models.removeEntry': 'Delete this entry',
  'models.deleted': 'Entry removed',
  'models.baseUrl': 'Base URL',
  'models.model': 'Model',
  'models.apiKey': 'API key',
  'models.keySaved': 'Saved — leave blank to keep',
  'models.keyEmpty': 'Not configured — paste an API key',
  'models.removeKey': 'Remove the saved API key',
  'models.removeKeyArmed': 'The saved key will be removed on save',
  'models.savedActive': 'Saved and activated',
  'models.saveUse': 'Save and use',

  // Web search
  'web.title': 'Web Search',
  'web.desc': 'Friday tries Tavily first, then falls back to AnySearch.',
  'web.keySaved': 'Saved — leave blank to keep',
  'web.keyEmpty': 'Not configured — paste an API key',
  'web.removeKey': 'Remove the saved {name} key',
  'web.removeKeyArmed': 'The {name} key will be removed on save',
  'web.saved': 'Search settings saved.',

  // Memory
  'memory.title': 'Memory',
  'memory.desc': 'Manage the persistent profile and memory files used across conversations.',
  'memory.userFile': 'User profile',
  'memory.globalFile': 'Global memory',
  'memory.chars': '{chars} / {limit} chars',
  'memory.saved': 'Saved.',

  // Docs
  'docs.title': 'Docs',
  'docs.desc': 'After installing, follow these steps to start using Friday.',
  'docs.step1.title': 'Set up a model provider',
  'docs.step1.body': 'Friday needs a model API key to chat. Open Models, expand any provider (such as DeepSeek), paste the key, and save — that provider is enabled automatically.',
  'docs.step2.title': 'Set up web search (optional)',
  'docs.step2.body': 'Web search needs a Tavily or AnySearch key. Fill one in under Web Search; Friday tries Tavily first and falls back to AnySearch.',
  'docs.step3.title': 'Let Friday remember you (optional)',
  'docs.step3.body': 'Set your name and Friday response language under General. Future conversations will carry these preferences.',
  'docs.go': 'Go to {target} ›',

  // Project drop
  'projectDrop.title': 'Open as a Friday project',
  'projectDrop.hint': 'Drop the folder anywhere in this window',
}

const zh: Record<string, string> = {
  // Chrome & sidebar
  'nav.skills': '技能',
  'nav.observability': '可观测性',
  'sidebar.projects': '项目',
  'sidebar.recent': '最近',
  'sidebar.phone': '手机',
  'sidebar.phoneEmpty': '手机端还没有会话',
  'sidebar.addProject': '添加项目',
  'sidebar.newConversation': '新会话',
  'sidebar.closeProject': '关闭项目',
  'sidebar.search': '搜索会话',
  'sidebar.empty': '暂无保存的会话',
  'sidebar.settings': '设置',
  'sidebar.rename': '重命名',
  'sidebar.delete': '删除',
  'sidebar.deleteConfirm': '删除「{title}」？',
  'sidebar.renamePrompt': '重命名会话',
  'status.working': '工作中',
  'status.apiKeyRequired': '需要 API key',
  'status.ready': '就绪',
  'status.error': '不可用',
  'status.idle': '未选择项目',
  'status.connecting': '正在连接',
  'conversation.new': '新会话',
  'theme.toDark': '切换到深色主题',
  'theme.toLight': '切换到浅色主题',

  // Composer
  'composer.placeholder': '让 Friday 做点什么（Enter 发送，Shift+Enter 换行）',
  'composer.starting': 'Friday 正在启动…',
  'composer.approvalBlocked': '请先处理待批准的请求…',
  'composer.send': '发送',
  'composer.stop': '停止',
  'composer.attach': '添加图片',
  'composer.removeAttachment': '移除图片',
  'composer.configureModels': '配置模型',
  'composer.model': '模型',
  'composer.thinking': '思考力度',
  'permission.title': '选择 Friday 处理危险命令的方式',
  'permission.manual': '需要批准',
  'permission.manual.desc': '危险操作前先询问',
  'permission.auto': 'Friday 自行判断',
  'permission.auto.desc': '由 Friday 审查危险操作',
  'permission.bypass': '完全放行',
  'permission.bypass.desc': '允许的命令直接执行',
  'effort.off': '关闭',
  'effort.off.desc': '关闭模型推理',
  'effort.low': '低',
  'effort.low.desc': '快速、轻量推理',
  'effort.high': '高',
  'effort.high.desc': '均衡的深度推理',
  'effort.max': '最高',
  'effort.max.desc': '最大推理力度',
  'project.personal': '个人会话',
  'composer.working': 'Friday 正在工作',
  'composer.visionRequired': '请先选择支持视觉的模型，再粘贴图片。',
  'modelMenu.keyConfigured': 'API key 已配置',
  'modelMenu.keyRequired': '需要 API key',

  // Welcome
  'welcome.greeting.morning': '早上好',
  'welcome.greeting.afternoon': '下午好',
  'welcome.greeting.evening': '晚上好',
  'welcome.greeting.late': '夜深了',
  'welcome.greeting.format': '{greeting}，{hint}',
  'welcome.0': '今天我们从哪里开始？',
  'welcome.1': '今天我能帮你做什么？',
  'welcome.2': '从一个想法开始吧。',
  'welcome.3': '想做点什么，尽管吩咐。',
  'welcome.4': '我准备好了，随时可以开工。',
  'welcome.5': '一起做点有用的事吧。',

  // Approval panel
  'approval.title': '需要批准',
  'approval.pendingCommand': '待批准命令',
  'approval.once': '批准一次',
  'approval.session': '本会话内允许',
  'approval.reject': '拒绝',
  'approval.guidance': '告诉 Friday 该怎么做…',
  'approval.send': '发送',

  // Verification
  'verification.pass': '验证通过',
  'verification.error': '验证异常',
  'verification.blocked': '验证受阻',
  'verification.inconclusive': '验证结果不确定',
  'verification.failed': '验证未通过',
  'verification.pending': '正在验证交付结果…',
  'verification.continuing': '正在根据验证反馈继续处理…',

  // Context compaction
  'context.compacted': '上下文已压缩（{before} → {after} tokens）。模型现在读到的是较早工作的摘要，加上最近 {turns} 步的完整内容；上面的对话记录全部保留。',
  'context.compactedPlain': '上下文已压缩，模型现在读到的是较早工作的摘要；上面的对话记录全部保留。',
  'context.compactedLocal': '模型不可用，摘要由 Friday 本地生成。',
  'context.trimmed': '上下文已精简：{count} 条工具结果被缩短，完整输出仍保存在磁盘上。',
  'context.compactFailed': '上下文压缩失败（{reason}），这次对话可能会触及模型上限。',

  // A project that disappeared from disk
  'project.missing': '已从侧边栏移除“{name}”：它的目录已不存在。如果目录恢复，可以重新添加。',

  // Why a turn ended early
  'stop.noProgress': 'Friday 提前停止：同一步骤反复得到相同结果。上面的回答是它当时掌握的内容。',
  'stop.contextWindow': 'Friday 提前停止：上下文窗口已满，压缩也无法腾出足够空间。',

  // Turn metrics
  'metrics.window': '上下文 {used}/{total}（{percent}）',
  'metrics.request': '1 次请求',
  'metrics.requests': '{count} 次请求',
  'metrics.cost': '输入 {input}（其中缓存 {cached}）/ 输出 {output}',
  'metrics.explain':
    '“上下文”是当前对话占用了多少窗口。token 数是本轮所有请求的累计值——每次请求都会把整段对话重新发一遍，所以它会远高于上下文占用；其中“缓存”部分由模型侧的前缀缓存命中，按远低于新输入的价格计费。',

  // Thinking
  'thinking.running': '思考中',
  'thinking.done': '思考了 {duration}',
  'thinking.interrupted': '思考中断 · {duration}',
  'thinking.runningWith': '思考中… {duration}',

  // Tools
  'tool.bash.verb': '运行命令',
  'tool.bash.doing': '正在运行命令',
  'tool.bash.did': '运行了命令',
  'tool.bash.doingMulti': '正在运行多个命令',
  'tool.bash.didMulti': '运行了多个命令',
  'tool.websearch.verb': '搜索网页',
  'tool.websearch.doing': '正在搜索网页',
  'tool.websearch.did': '搜索了网页',
  'tool.websearch.doingMulti': '正在进行多次网页搜索',
  'tool.websearch.didMulti': '进行了多次网页搜索',
  'tool.webfetch.verb': '读取网页',
  'tool.webfetch.doing': '正在读取网页',
  'tool.webfetch.did': '读取了网页',
  'tool.webfetch.doingMulti': '正在读取多个网页',
  'tool.webfetch.didMulti': '读取了多个网页',
  'tool.read.verb': '读取文件',
  'tool.read.doing': '正在读取文件',
  'tool.read.did': '读取了文件',
  'tool.read.doingMulti': '正在读取多个文件',
  'tool.read.didMulti': '读取了多个文件',
  'tool.write.verb': '修改文件',
  'tool.write.doing': '正在修改文件',
  'tool.write.did': '修改了文件',
  'tool.write.doingMulti': '正在修改多个文件',
  'tool.write.didMulti': '修改了多个文件',
  'tool.find.verb': '查找文件',
  'tool.find.doing': '正在查找文件',
  'tool.find.did': '查找了文件',
  'tool.find.doingMulti': '正在进行多次文件查找',
  'tool.find.didMulti': '进行了多次文件查找',
  'tool.plan.verb': '更新任务进度',
  'tool.plan.doing': '正在更新任务进度',
  'tool.plan.did': '更新了任务进度',
  'tool.plan.doingMulti': '正在多次更新任务进度',
  'tool.plan.didMulti': '多次更新了任务进度',
  'tool.generic.verb': '使用工具',
  'tool.generic.doing': '正在使用工具',
  'tool.generic.did': '使用了工具',
  'tool.generic.doingMulti': '正在多次使用工具',
  'tool.generic.didMulti': '执行了多项工具操作',
  'activity.approval': '等待批准：{verb}',
  'activity.error': '{verb}时遇到问题',
  'activity.approvalMulti': '等待批准：多项操作',
  'activity.errorMulti': '部分操作失败',

  // Sources
  'sources.label': '参考了 {count} 个页面',
  'sources.aria': '参考了 {count} 个页面',
  'sources.trigger': '来源',

  // Fork map
  'fork.show': '展开会话分支图',
  'fork.hide': '收起分支图',
  'fork.main': '主会话',
  'fork.fork': 'Fork 会话',
  'fork.from': '从「{title}」分出',
  'fork.open': '打开',
  'fork.delete': '删除',

  // Artifacts
  'artifact.image': '图片',
  'artifact.markdown': 'Markdown',
  'artifact.pdf': 'PDF',
  'artifact.text': '文本',

  // Skills browser
  'skills.search': '搜索技能…',
  'skills.tagline': 'Friday 可用的可复用工作流',
  'skills.installed': '已安装',
  'skills.empty': '没有匹配的技能',
  'skills.close': '关闭',
  'skills.back': '返回',

  // Settings shared
  'settings.back': '返回',
  'settings.loading': '正在加载设置…',
  'settings.save': '保存',
  'settings.saving': '正在保存…',
  'settings.saved': '已保存。',
  'badge.configured': '已配置',
  'badge.unconfigured': '未配置',
  'secret.show': '显示',
  'secret.hide': '隐藏',

  // Settings nav
  'settings.general': '通用',
  'settings.general.hint': '语言与偏好',
  'settings.models': '模型',
  'settings.models.hint': '供应商与 API key',
  'settings.web': '联网搜索',
  'settings.web.hint': 'Tavily 与 AnySearch',
  'settings.phone': '手机',
  'settings.phone.hint': '用飞书操作这个工作区',
  'settings.memory': '记忆',
  'settings.memory.hint': '持久记忆文件',
  'settings.docs': '文档',
  'settings.docs.hint': '快速上手',

  // Phone bridge
  'phone.title': '手机',
  'phone.desc': '用手机上的飞书把活派给这个工作区。手机和电脑各自保留自己的会话。',
  'phone.on': '手机可以连上',
  'phone.onHint': '白名单账号发来的消息会在这里执行。关掉 Friday 就会断开。',
  'phone.off': '手机连不上',
  'phone.offHint': '打开开关即可接收飞书消息。',
  'phone.needsSetup': '请先填写 App ID 与 App Secret。',
  'phone.start': '打开',
  'phone.stop': '关闭',
  'phone.appId': 'App ID',
  'phone.appIdHint': 'cli_...',
  'phone.appSecret': 'App Secret',
  'phone.removeSecret': '删除已保存的 Secret',
  'phone.removeSecretArmed': '保存后将删除 Secret',
  'phone.allowedUsers': '允许的账号',
  'phone.allowedUsersPlaceholder': 'ou_...',
  'phone.allowedUsersHint': '每行一个飞书 open_id。不在列表里的一律拒绝。',
  'phone.pairing': '还没有允许任何账号，所以所有消息都会被拒绝。先打开开关，给机器人发一条消息，再把下方日志里的 open_id 填进上面的列表。',
  'phone.groupOn': '允许群聊，需要 @ 机器人',
  'phone.groupOff': '拒绝群聊',
  'phone.log': '桥接输出',
  'phone.saved': '已保存。关闭再打开开关即可生效。',

  // General
  'general.title': '通用',
  'general.desc': '这台设备上的偏好设置。',
  'general.uiLanguage': '界面语言',
  'general.uiLanguageNote': '只改变桌面界面，不决定 Friday 使用哪种语言回答。',
  'general.profileNote': '以下设置会更新用户档案，并影响 Friday 对你的称呼和回复语言。',
  'general.name': '你的称呼',
  'general.namePlaceholder': 'Friday 该如何称呼你？',
  'general.responseLanguage': 'Friday 交互语言',
  'general.responseLanguagePlaceholder': '例如：中文',
  'models.title': '模型',
  'models.desc': '内置厂商只需填入 API key，Friday 会自动发现其模型；其他 OpenAI 兼容服务请在下方自行添加。',
  'models.inUse': '使用中',
  'models.builtinHint': '保存 key 时会自动获取该厂商的模型列表。',
  'models.discoveredCount': '已发现 {n} 个模型，可在聊天输入框的模型菜单中选用',
  'models.customHint': '任何兼容 OpenAI 聊天接口的服务：填入 Base URL、模型 ID 和 API key。',
  'models.addCustom': '添加 OpenAI 兼容接入点',
  'models.addCustomHint': '自行填写 Base URL 与 API key',
  'models.name': '名称',
  'models.removeEntry': '删除该配置',
  'models.deleted': '已删除',
  'models.baseUrl': 'Base URL',
  'models.model': 'Model',
  'models.apiKey': 'API key',
  'models.keySaved': '已保存 key，留空则保持不变',
  'models.keyEmpty': '尚未配置，请粘贴 API key',
  'models.removeKey': '移除已保存的 API key',
  'models.removeKeyArmed': '保存时将移除已存的 key',
  'models.savedActive': '已保存并启用',
  'models.saveUse': '保存并使用',

  // Web search
  'web.title': '联网搜索',
  'web.desc': 'Friday 会优先使用 Tavily，不可用时回退到 AnySearch。',
  'web.keySaved': '已保存，留空则保持不变',
  'web.keyEmpty': '尚未配置，请粘贴 API key',
  'web.removeKey': '移除已保存的 {name} key',
  'web.removeKeyArmed': '保存时将移除 {name} key',
  'web.saved': '搜索服务设置已保存。',

  // Memory
  'memory.title': '记忆',
  'memory.desc': '管理跨会话使用的持久用户档案与记忆文件。',
  'memory.userFile': '用户档案',
  'memory.globalFile': '全局记忆',
  'memory.chars': '{chars} / {limit} 字符',
  'memory.saved': '已保存。',

  // Docs
  'docs.title': '文档',
  'docs.desc': '安装完成后，按下面几步即可开始使用 Friday。',
  'docs.step1.title': '配置模型服务',
  'docs.step1.body': 'Friday 需要模型 API key 才能对话。打开模型页，展开任意供应商（如 DeepSeek），粘贴 key 并保存，该供应商即自动启用。',
  'docs.step2.title': '配置搜索服务（可选）',
  'docs.step2.body': '联网搜索需要 Tavily 或 AnySearch 的 key，在联网搜索页填入即可。Friday 会优先使用 Tavily，不可用时回退到 AnySearch。',
  'docs.step3.title': '让 Friday 记住你（可选）',
  'docs.step3.body': '在通用页中设置称呼和 Friday 交互语言，之后的对话会自动带上这些偏好。',
  'docs.go': '前往{target} ›',

  // Project drop
  'projectDrop.title': '作为 Friday 项目打开',
  'projectDrop.hint': '将目录拖放到窗口中的任意位置',
}

const STRINGS: Record<Language, Record<string, string>> = { en, zh }

export function t(key: string, vars?: Record<string, string | number>) {
  let text = STRINGS[current][key] ?? en[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
