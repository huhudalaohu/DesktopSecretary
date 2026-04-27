// AI 助手共享配置

export const MODEL_PROVIDERS = {
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'moonshot-v1-8k',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  tongyi: {
    label: '通义千问 (Aliyun)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'qwen-max',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  wenxin: {
    label: '文心一言 (Baidu)',
    baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat',
    headers: (key) => ({
      'Content-Type': 'application/json',
    }),
    buildBody: (messages) => ({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    buildUrl: (baseUrl, key) => `${baseUrl}/completions?access_token=${key}`,
    extractContent: (data) => data.result || data.choices?.[0]?.message?.content || '',
  },
  doubao: {
    label: '豆包 (ByteDance)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'doubao-pro-4k',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => {
      const msg = data.choices?.[0]?.message;
      if (!msg) return '';
      return msg.content || msg.reasoning_content || '';
    },
  },
};

export const PROVIDER_KEYS = Object.keys(MODEL_PROVIDERS);

export const DEFAULT_AI_SETTINGS = {
  provider: 'kimi',
  apiKey: '',
  customBaseUrl: '',
  customModel: '',
  shortcutKey: 'CmdOrCtrl+Shift+A',
};

export const SCREENSHOT_PROMPT = `请分析这张截图，提取待办事项。如果是聊天/邮件/文档：
- 任务内容：提炼具体要做什么（不超过50字，过长时压缩为"动词+对象"核心结构）
- 截止时间：如果有明确时间（如"周五下班前"），转换为 YYYY-MM-DD HH:mm；模糊时间（如"尽快"）标注为"尽快"
- 优先级：根据紧急程度标记 urgent/high/medium/low
- 任务来源(sourcePerson)：指出发布/指派这个任务的人（聊天记录里的发送者、邮件发件人、文档中的@发起者）

特别注意：
1. 不要提取"@金越虎"作为执行者，要提取的是说"@金越虎 把这个做了"的那个人（发布者）。
2. 如果来源是聊天记录或邮件，title 必须直接返回"来源人：任务内容"的格式，例如"张三：今天下午完成设计稿"、"李四：明天之前把报价发给我"。不要单独在 sourcePerson 里返回，要直接拼在 title 前面。

返回 JSON 格式：{tasks: [{title, deadline, priority}]}`;

export const MEMORY_SUMMARY_PROMPT = `请总结以下用户与AI的对话，提取关键信息（项目名称、待办、决策、文件路径），用于后续检索。摘要不超过100字，同时提取3-5个关键词。`;
