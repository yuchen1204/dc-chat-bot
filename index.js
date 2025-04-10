// Import dotenv, discordJS and openai
require("dotenv").config();
const { Client, IntentsBitField, PermissionsBitField, ChannelType, ActivityType } = require("discord.js");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");
const axios = require("axios"); // 添加axios用于API请求
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 添加Google Gemini API

// 用户会话跟踪
const userSessions = new Map();
const SESSION_TIMEOUT = 30000; // 30秒会话超时
const SESSION_EMOJI = "💬"; // 会话状态emoji标记
const GEMINI_EMOJI = "🤖"; // Gemini会话状态emoji标记

// Redis客户端配置
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  socket: {
    tls: true,
    rejectUnauthorized: false
  }
});

// 连接Redis
(async () => {
  try {
    await redisClient.connect();
    console.log("Redis连接成功！");
  } catch (err) {
    console.error("Redis连接失败:", err);
  }
})();

// 处理Redis连接错误
redisClient.on("error", (err) => {
  console.error("Redis错误:", err);
});

// 添加Bot状态更新相关配置
const STATUS_UPDATE_INTERVAL = 10 * 60 * 1000; // 10分钟更新一次
const STATUS_EMOJI_LIST = ['🎮', '🎵', '📺', '📚', '🎨', '💭', '🏃', '💬', '🏆', '📱', '🍜', '🚶', '🛒', '😊', '🎯'];
// 保存最近使用过的状态类型，避免重复
const RECENT_STATUSES = [];
const MAX_RECENT_STATUSES = 10; // 记录最近10个状态

// Discord Config
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
client.on("ready", () => {
  console.log(`[${new Date().toISOString()}] Bot已登录成功! 用户名: ${client.user.tag}, ID: ${client.user.id}`);
  console.log(`[${new Date().toISOString()}] 当前服务器数量: ${client.guilds.cache.size}`);
  
  // 启动时更新一次状态
  console.log(`[${new Date().toISOString()}] 正在尝试设置初始状态...`);
  updateBotStatus().catch(err => {
    console.error(`[${new Date().toISOString()}] 设置初始状态失败:`, err);
  });
  
  // 设置定时更新状态
  console.log(`[${new Date().toISOString()}] 设置状态更新定时器: ${STATUS_UPDATE_INTERVAL/60000}分钟`);
  setInterval(() => {
    console.log(`[${new Date().toISOString()}] 定时器触发，正在更新状态...`);
    updateBotStatus().catch(err => {
      console.error(`[${new Date().toISOString()}] 定时更新状态失败:`, err);
    });
  }, STATUS_UPDATE_INTERVAL);
});
client.login(process.env.Discord_Token);

// OpenAi Config
const openai = new OpenAI({
  apiKey: process.env.OpenAI_API,
});

// Google Gemini Config
const geminiApi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = geminiApi.getGenerativeModel({ model: "gemini-2.0-flash" });

// 加载知识库
let knowledgeBase = {};
try {
  const knowledgeFilePath = path.join(__dirname, "knowledge.json");
  const knowledgeData = fs.readFileSync(knowledgeFilePath, "utf8");
  knowledgeBase = JSON.parse(knowledgeData);
  console.log("知识库加载成功！");
} catch (error) {
  console.error("加载知识库时出错:", error);
}

// 从知识库中检索答案
function searchKnowledgeBase(query) {
  if (!knowledgeBase.questions || !Array.isArray(knowledgeBase.questions)) {
    return null;
  }

  // 将查询转换为小写以进行不区分大小写的匹配
  const lowercaseQuery = query.toLowerCase();

  // 检查每个问题的关键词是否与查询匹配
  for (const item of knowledgeBase.questions) {
    if (!item.keywords || !Array.isArray(item.keywords)) continue;

    // 如果查询中包含任何关键词，返回对应的答案
    for (const keyword of item.keywords) {
      if (lowercaseQuery.includes(keyword.toLowerCase())) {
        return item.answer;
      }
    }
  }

  // 没有找到匹配项
  return null;
}

// 添加重试函数
async function createChatCompletionWithRetry(messages, model = "gpt-4o-mini", maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await openai.chat.completions.create({
        model: model,
        messages: messages,
      });
    } catch (error) {
      if (error.status === 429) {
        // 如果是速率限制错误，等待一段时间再重试
        retries++;
        console.log(`Rate limit hit, retrying ${retries}/${maxRetries} after delay...`);
        // 指数退避策略：等待时间随重试次数增加
        const delay = 1000 * Math.pow(2, retries);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // 其他错误直接抛出
        throw error;
      }
    }
  }
  throw new Error("Max retries reached for API request");
}

// 添加重试函数 - 为Gemini API添加
async function createGeminiChatWithRetry(messages, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      // 转换消息格式为Gemini API格式
      const geminiMessages = messages.map(msg => {
        if (msg.role === "system") {
          // Gemini API不直接支持system角色，将其转为user消息
          return {
            role: "user",
            parts: [{ text: `系统指令（请在整个对话中遵循）: ${msg.content}` }]
          };
        } else {
          return {
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }]
          };
        }
      });

      // 创建聊天会话
      const chat = geminiModel.startChat({
        history: geminiMessages.slice(0, -1), // 历史消息
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        },
      });

      // 发送最后一条消息
      const lastMessage = geminiMessages[geminiMessages.length - 1];
      const result = await chat.sendMessage(lastMessage.parts[0].text);
      return result.response.text();
    } catch (error) {
      retries++;
      console.log(`Gemini API error, retrying ${retries}/${maxRetries} after delay...`, error);
      const delay = 1000 * Math.pow(2, retries);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Max retries reached for Gemini API request");
}

// 用户聊天记忆相关函数
const MEMORY_EXPIRATION = 60 * 60 * 24 * 30; // 聊天记忆保存30天

// 保存用户消息到Redis
async function saveUserMessage(userId, content, useGemini = false) {
  try {
    // 使用统一的键名，不再区分不同模型
    const key = `chat:${userId}:unified_messages`;
    const message = {
      role: "user",
      content,
      timestamp: Date.now(),
      // 添加来源标记，但不影响消息格式
      source: useGemini ? "gemini" : "openai",
      model: useGemini ? "gemini-2.0-flash" : "gpt-4o-mini"
    };
    
    // 获取当前的消息历史
    const currentHistory = await getUserChatHistory(userId);
    
    // 添加新消息
    currentHistory.push(message);
    
    // 如果历史消息超过20条，删除最早的消息
    if (currentHistory.length > 100) {
      currentHistory.shift();
    }
    
    // 保存更新后的历史记录
    await redisClient.set(key, JSON.stringify(currentHistory), {
      EX: MEMORY_EXPIRATION
    });
    
    return true;
  } catch (error) {
    console.error("保存用户消息时出错:", error);
    return false;
  }
}

// 保存AI回复到Redis
async function saveAIResponse(userId, content, useGemini = false) {
  try {
    // 使用统一的键名，不再区分不同模型
    const key = `chat:${userId}:unified_messages`;
    const message = {
      role: "assistant",
      content,
      timestamp: Date.now(),
      // 添加来源标记，但不影响消息格式
      source: useGemini ? "gemini" : "openai",
      model: useGemini ? "gemini-2.0-flash" : "gpt-4o-mini"
    };
    
    // 获取当前的消息历史
    const currentHistory = await getUserChatHistory(userId);
    
    // 添加新消息
    currentHistory.push(message);
    
    // 如果历史消息超过20条，删除最早的消息
    if (currentHistory.length > 100) {
      currentHistory.shift();
    }
    
    // 保存更新后的历史记录
    await redisClient.set(key, JSON.stringify(currentHistory), {
      EX: MEMORY_EXPIRATION
    });
    
    return true;
  } catch (error) {
    console.error("保存AI回复时出错:", error);
    return false;
  }
}

// 获取用户聊天历史
async function getUserChatHistory(userId) {
  try {
    // 使用统一的键名，不再区分不同模型
    const key = `chat:${userId}:unified_messages`;
    const history = await redisClient.get(key);
    
    if (!history) {
      return [];
    }
    
    return JSON.parse(history);
  } catch (error) {
    console.error("获取用户聊天历史时出错:", error);
    return [];
  }
}

// 清除用户聊天历史
async function clearUserChatHistory(userId) {
  try {
    // 清除旧的分离式历史记录
    const oldOpenaiKey = `chat:${userId}:messages`;
    const oldGeminiKey = `gemini:${userId}:messages`;
    // 清除新的统一历史记录
    const unifiedKey = `chat:${userId}:unified_messages`;
    
    await redisClient.del(oldOpenaiKey);
    await redisClient.del(oldGeminiKey);
    await redisClient.del(unifiedKey);
    return true;
  } catch (error) {
    console.error("清除用户聊天历史时出错:", error);
    return false;
  }
}

// 检查用户是否处于活跃会话中
function isUserInActiveSession(userId, channelId) {
  const sessionKey = `${userId}-${channelId}`;
  if (!userSessions.has(sessionKey)) {
    return false;
  }
  
  const sessionData = userSessions.get(sessionKey);
  const now = Date.now();
  
  // 如果会话已超时，删除会话记录并返回false
  if (now - sessionData.lastActivity > SESSION_TIMEOUT) {
    userSessions.delete(sessionKey);
    return false;
  }
  
  return true;
}

// 更新用户会话活跃时间
function updateUserSession(userId, channelId, isNewSession = false, useGemini = false) {
  const sessionKey = `${userId}-${channelId}`;
  const now = Date.now();
  
  // 获取现有会话或创建新会话
  const existingSession = userSessions.get(sessionKey) || {};
  
  // 更新会话数据
  userSessions.set(sessionKey, {
    lastActivity: now,
    isNotified: isNewSession ? false : (existingSession.isNotified || false), // 新会话时重置通知状态
    startTime: isNewSession ? now : (existingSession.startTime || now), // 新会话时更新开始时间
    isNewSession: isNewSession, // 是否是新会话
    useGemini: useGemini // 使用的AI模型 - 始终使用传入的值
  });
  
  console.log(`会话更新: 用户=${userId}, 频道=${channelId}, 新会话=${isNewSession}, 使用Gemini=${useGemini}`);
  
  // 设置会话超时清理
  setTimeout(() => {
    // 只有当会话未被更新时才删除
    const session = userSessions.get(sessionKey);
    if (session && now - session.lastActivity >= SESSION_TIMEOUT - 1000) {
      userSessions.delete(sessionKey);
      console.log(`用户 ${userId} 在频道 ${channelId} 的会话已超时`);
    }
  }, SESSION_TIMEOUT + 1000); // 添加1秒额外时间确保准确性
}

// 检查是否是清除频道内容的指令
function isClearChannelCommand(content) {
  const lowerContent = content.toLowerCase();
  return (
    (lowerContent.includes("清除") || 
     lowerContent.includes("删除") || 
     lowerContent.includes("清理") || 
     lowerContent.includes("清空") ||
     lowerContent.includes("clear")) && 
    (lowerContent.includes("内容") || 
     lowerContent.includes("消息") || 
     lowerContent.includes("聊天") ||
     lowerContent.includes("频道") ||
     lowerContent.includes("channel") ||
     lowerContent.includes("message"))
  );
}

// 检查是否是清除聊天记忆的命令
function isClearMemoryCommand(content) {
  const lowerContent = content.toLowerCase();
  return (
    (lowerContent.includes("清除") || 
     lowerContent.includes("删除") || 
     lowerContent.includes("清理") || 
     lowerContent.includes("重置") ||
     lowerContent.includes("忘记") ||
     lowerContent.includes("forget") ||
     lowerContent.includes("reset")) && 
    (lowerContent.includes("记忆") || 
     lowerContent.includes("记录") || 
     lowerContent.includes("历史") ||
     lowerContent.includes("聊天记录") ||
     lowerContent.includes("memory") ||
     lowerContent.includes("history") ||
     lowerContent.includes("conversation"))
  );
}

// 从消息中提取频道ID
function extractChannelFromMessage(msg) {
  // 查找消息中被提及的频道（格式为 <#channelID>）
  const channelMentionRegex = /<#(\d+)>/g;
  const mentionMatches = msg.content.match(channelMentionRegex);
  
  if (mentionMatches && mentionMatches.length > 0) {
    // 从第一个提及的频道提取ID
    const channelId = mentionMatches[0].replace(/<#|>/g, '');
    return msg.guild.channels.cache.get(channelId);
  }
  
  // 如果没有直接提及频道，尝试查找 #频道名 格式
  const hashtagRegex = /#(\S+)/g;
  const hashtagMatches = msg.content.match(hashtagRegex);
  
  if (hashtagMatches && hashtagMatches.length > 0) {
    // 获取第一个#后面的频道名称
    const channelName = hashtagMatches[0].substring(1);
    // 在服务器中查找这个名称的频道
    return msg.guild.channels.cache.find(
      channel => channel.name.toLowerCase() === channelName.toLowerCase()
    );
  }
  
  // 如果都没找到，默认返回当前频道
  return msg.channel;
}

// 添加一个用于标记正在确认清除的用户集合
const pendingClearConfirmations = new Set();

// 修改清除频道内容函数
async function clearChannelMessages(channel, msg) {
  try {
    // 获取用户ID和频道ID的组合作为唯一标识
    const confirmationKey = `${msg.author.id}-${msg.channel.id}`;
    
    // 检查用户是否已经有待确认的清除操作
    if (pendingClearConfirmations.has(confirmationKey)) {
      return msg.reply("您已经有一个待确认的清除操作，请先回复确认或等待操作超时。");
    }
    
    // 检查用户是否有管理消息的权限
    if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return msg.reply("很抱歉，您没有权限清除频道内容。需要拥有「管理消息」权限。");
    }
    
    // 检查是否为文本频道
    if (channel.type !== ChannelType.GuildText) {
      return msg.reply("只能清除文本频道的内容。");
    }
    
    // 检查机器人是否有权限
    if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
      return msg.reply(`我没有在 <#${channel.id}> 中管理消息的权限。`);
    }

    // 添加到待确认集合
    pendingClearConfirmations.add(confirmationKey);

    // 发送确认消息
    const confirmMsg = await msg.reply(`确定要清除 <#${channel.id}> 频道的消息吗？请在30秒内回复「确定」或「是」确认操作。`);
    
    // 设置过滤器，只接受原消息作者的回复
    const filter = m => m.author.id === msg.author.id && 
                        (m.content.includes("确定") || 
                         m.content.includes("是") || 
                         m.content.toLowerCase().includes("yes"));
    
    // 等待用户确认
    try {
      const collected = await msg.channel.awaitMessages({ 
        filter, 
        max: 1, 
        time: 30000, 
        errors: ['time'] 
      });
      
      // 用户已确认，开始清除消息
      const startMsg = await msg.channel.send(`开始清除 <#${channel.id}> 的消息...`);
      
      let deletedCount = 0;
      let lastMessageId = null;
      
      // 循环批量删除消息，直到没有更多消息
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100, before: lastMessageId });
        
        if (messages.size === 0) break;
        
        // 更新最后一条消息的ID，用于下一轮获取
        lastMessageId = messages.last().id;
        
        // 过滤出两周内的消息（Discord API限制）
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        
        const recentMessages = messages.filter(m => m.createdAt > twoWeeksAgo);
        
        if (recentMessages.size === 0) {
          // 创建新消息而不是回复
          await channel.send("无法删除两周以前的消息，操作已完成。");
          break;
        }
        
        // 批量删除消息
        await channel.bulkDelete(recentMessages);
        
        deletedCount += recentMessages.size;
        
        // 如果批量删除的消息数量小于获取的消息数量，说明有些消息太旧无法删除
        if (recentMessages.size < messages.size) {
          // 创建新消息而不是回复
          await channel.send("无法删除两周以前的消息，操作已完成。");
          break;
        }
      }
      
      // 创建新消息而不是回复
      const result = await channel.send(`已成功清除 <#${channel.id}> 中的 ${deletedCount} 条消息。`);
      
      // 从待确认集合中移除
      pendingClearConfirmations.delete(confirmationKey);
      
      return result;
      
    } catch (error) {
      // 从待确认集合中移除
      pendingClearConfirmations.delete(confirmationKey);
      
      // 用户没有在指定时间内确认
      if (error instanceof Map) {
        return msg.channel.send("操作已取消：没有收到确认回复。");
      } else {
        console.error("清除消息时发生错误:", error);
        return msg.channel.send("清除消息时发生错误，请稍后再试。");
      }
    }
  } catch (error) {
    // 从待确认集合中移除
    const confirmationKey = `${msg.author.id}-${msg.channel.id}`;
    pendingClearConfirmations.delete(confirmationKey);
    
    console.error("执行清除命令时出错:", error);
    // 创建新消息而不是回复
    return channel.send("执行清除命令时发生错误，请稍后再试。");
  }
}

// 修改清除用户记忆功能
async function clearUserMemory(msg) {
  try {
    // 获取用户ID和频道ID的组合作为唯一标识
    const confirmationKey = `${msg.author.id}-${msg.channel.id}`;
    
    // 检查用户是否已经有待确认的清除操作
    if (pendingClearConfirmations.has(confirmationKey)) {
      return msg.reply("您已经有一个待确认的清除操作，请先回复确认或等待操作超时。");
    }
    
    const userId = msg.author.id;
    
    // 添加到待确认集合
    pendingClearConfirmations.add(confirmationKey);
    
    // 发送确认消息
    const confirmMsg = await msg.reply(`我理解您想要清除我们之间的聊天记忆。这将会删除我保存的所有对话历史，让我们可以重新开始对话。请在30秒内回复「确定」或「是」确认操作。`);
    
    // 设置过滤器，只接受原消息作者的回复
    const filter = m => m.author.id === msg.author.id && 
                        (m.content.includes("确定") || 
                         m.content.includes("是") || 
                         m.content.toLowerCase().includes("yes"));
    
    // 等待用户确认
    try {
      const collected = await msg.channel.awaitMessages({ 
        filter, 
        max: 1, 
        time: 30000, 
        errors: ['time'] 
      });
      
      // 用户已确认，开始清除记忆
      const success = await clearUserChatHistory(userId);
      
      // 从待确认集合中移除
      pendingClearConfirmations.delete(confirmationKey);
      
      if (success) {
        return msg.reply("已成功清除我们之间的所有聊天记忆。从现在开始，我们可以开始新的对话了。如果您有任何问题，随时都可以问我！");
      } else {
        return msg.reply("抱歉，清除聊天记忆时出现了技术问题。请稍后再试一次。如果问题持续存在，请联系管理员。");
      }
      
    } catch (error) {
      // 从待确认集合中移除
      pendingClearConfirmations.delete(confirmationKey);
      
      // 用户没有在指定时间内确认
      if (error instanceof Map) {
        return msg.channel.send("操作已取消：没有收到确认回复。");
      } else {
        console.error("清除聊天记忆时发生错误:", error);
        return msg.channel.send("清除聊天记忆时发生错误，请稍后再试。");
      }
    }
  } catch (error) {
    // 从待确认集合中移除
    const confirmationKey = `${msg.author.id}-${msg.channel.id}`;
    pendingClearConfirmations.delete(confirmationKey);
    
    console.error("执行清除聊天记忆命令时出错:", error);
    return msg.reply("执行清除命令时发生错误，请稍后再试。");
  }
}

// 获取当前时间信息
async function getCurrentTimeInfo() {
  try {
    const response = await axios.get("https://timeapi.io/api/time/current/zone?timeZone=Asia%2FKuala_Lumpur");
    return {
      success: true,
      data: response.data,
      formattedDate: `${response.data.year}-${String(response.data.month).padStart(2, '0')}-${String(response.data.day).padStart(2, '0')}`,
      formattedTime: `${String(response.data.hour).padStart(2, '0')}:${String(response.data.minute).padStart(2, '0')}`,
      dayOfWeek: response.data.dayOfWeek,
      year: response.data.year,
      month: response.data.month,
      day: response.data.day,
      fullDateTimeString: response.data.dateTime
    };
  } catch (error) {
    console.error("获取时间信息失败，使用本地时间作为备用:", error);
    // 使用本地时间作为备用
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // getMonth()返回0-11
    const day = now.getDate();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    // 星期几转换
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayOfWeek = days[now.getDay()];
    
    return {
      success: true,
      usingFallback: true,
      data: {
        year, month, day, hour, minute,
        dayOfWeek,
        dateTime: now.toISOString()
      },
      formattedDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      dayOfWeek,
      year,
      month,
      day,
      fullDateTimeString: now.toISOString()
    };
  }
}

// 修改处理用户消息函数，增加对清除操作确认中的处理
async function processUserMessage(msg, query, useGemini = false) {
  try {
    // 检查用户是否正在确认清除操作
    const confirmationKey = `${msg.author.id}-${msg.channel.id}`;
    if (pendingClearConfirmations.has(confirmationKey)) {
      // 正在等待确认，不处理为普通消息
      if (query.includes("确定") || query.includes("是") || query.toLowerCase().includes("yes")) {
        console.log("检测到清除确认回复，不作为普通消息处理");
        return null; // 不处理这条消息，因为它是清除确认的回复
      }
    }
    
    // 获取当前时间信息
    const timeInfo = await getCurrentTimeInfo();
    let currentTimeContext = "";
    
    if (timeInfo.success) {
      const chineseDayOfWeek = timeInfo.dayOfWeek === "Monday" ? "一" : 
                               timeInfo.dayOfWeek === "Tuesday" ? "二" : 
                               timeInfo.dayOfWeek === "Wednesday" ? "三" : 
                               timeInfo.dayOfWeek === "Thursday" ? "四" : 
                               timeInfo.dayOfWeek === "Friday" ? "五" : 
                               timeInfo.dayOfWeek === "Saturday" ? "六" : "日";
      
      currentTimeContext = `当前时间是 ${timeInfo.formattedDate} ${timeInfo.formattedTime}，星期${chineseDayOfWeek}。
今天是 ${timeInfo.year}年${timeInfo.month}月${timeInfo.day}日。
请在回答与时间、日期或当前事件相关的问题时，基于这个最新时间信息，而不是你训练数据的截止日期。`;
    }
    
    // 检查是否是清除聊天记忆的命令
    if (isClearMemoryCommand(query)) {
      console.log("检测到清除聊天记忆命令");
      return await clearUserMemory(msg);
    }
    
    // 检查是否是清除频道内容的命令
    if (isClearChannelCommand(query)) {
      console.log("检测到清除频道内容的命令");
      const targetChannel = extractChannelFromMessage(msg);
      return await clearChannelMessages(targetChannel, msg);
    }
    
    // 检查知识库中是否有匹配的内容
    const knowledgeAnswer = searchKnowledgeBase(query);
    
    // 构建对话历史 - 使用Redis存储的用户聊天记录
    let ConvoLog = [{ 
      role: "system", 
      content: `你是一个有用的助手，${useGemini ? "名字是YY" : "名字是cc"}。${currentTimeContext}请根据用户的问题提供帮助。你的知识库可能截至2023年，但你应该使用提供给你的当前时间信息来回答与时间相关的问题。
如果用户提到了之前与其他模型的对话，请理解并衔接之前的对话。当前你使用的是${useGemini ? "Google Gemini" : "OpenAI GPT-4o Mini"}模型，但用户可能之前与${useGemini ? "OpenAI GPT-4o Mini" : "Google Gemini"}模型交谈过。

请使用Discord支持的Markdown格式来优化你的回复：
1. 对于代码，使用代码块，例如：\`\`\`python\nprint("Hello World")\n\`\`\`
2. 对于列表，使用Markdown列表，例如：
   - 项目1
   - 项目2
3. 对于强调内容，使用**加粗**或*斜体*
4. 对于标题，使用#、##等
5. 对于引用，使用>符号
6. 对于表格，使用Markdown表格格式
7. 根据用户的需求选择最适合的格式，使内容清晰易读

特别注意：
- 当用户要求代码或提到"代码块"、"示例代码"、"代码示例"等，务必使用\`\`\`语言名\n代码\n\`\`\`格式
- 当用户提到"列表"、"列出"、"排序"等，使用有序或无序列表格式
- 当用户要求"表格"、"表单"等，使用Markdown表格格式
- 分析用户请求中隐含的格式需求，如用户希望比较多个选项时，考虑使用表格或列表` 
    }];

    // 从Redis获取用户聊天历史（现在是统一的历史记录）
    const userId = msg.author.id;
    const userHistory = await getUserChatHistory(userId);
    
    // 将用户历史消息添加到对话记录中（不再区分来源）
    if (userHistory && userHistory.length > 0) {
      userHistory.forEach(message => {
        // 只保留标准字段，去除额外元数据
        ConvoLog.push({
          role: message.role,
          content: message.content
        });
      });
    }
    
    // 保存当前用户消息到Redis
    await saveUserMessage(userId, query, useGemini);
    
    // 添加当前查询
    ConvoLog.push({
      role: "user",
      content: query
    });

    let response;
    let aiReplyContent;
    
    // 如果知识库中有匹配的内容，将其添加到系统提示中
    if (knowledgeAnswer) {
      console.log("在知识库中找到匹配的答案:", knowledgeAnswer);
      
      // 将知识库答案添加到系统提示中
      ConvoLog[0].content += `\n\n请参考以下知识库中的信息回答用户问题：\n${knowledgeAnswer}`;
    }
    
    // 根据模型选择使用不同的API
    if (useGemini) {
      console.log("使用Google Gemini模型处理请求");
      try {
        aiReplyContent = await createGeminiChatWithRetry(ConvoLog);
      } catch (error) {
        console.error("Gemini API错误，尝试使用OpenAI作为备用:", error);
        // 如果Gemini失败，尝试使用OpenAI作为备用
        response = await createChatCompletionWithRetry(ConvoLog);
        aiReplyContent = response.choices[0].message.content;
      }
    } else {
      console.log("使用OpenAI模型处理请求");
      response = await createChatCompletionWithRetry(ConvoLog);
      aiReplyContent = response.choices[0].message.content;
    }

    // 保存AI回复到用户历史
    await saveAIResponse(userId, aiReplyContent, useGemini);
    
    try {
      // 添加模型标识，帮助用户识别当前使用的模型
      const modelPrefix = useGemini ? "[YY回复] " : "[CC回复] ";
      
      // 尝试回复消息，如果失败则发送新消息
      return await msg.reply(modelPrefix + aiReplyContent);
    } catch (error) {
      console.error("回复消息失败，尝试发送新消息:", error);
      const modelPrefix = useGemini ? "[YY回复] " : "[CC回复] ";
      return await msg.channel.send(modelPrefix + aiReplyContent);
    }
  } catch (e) {
    console.log(e);
    try {
      return await msg.reply("很抱歉，处理您的请求时出现了问题。请稍后再试。");
    } catch (error) {
      console.error("回复错误消息失败，尝试发送新消息:", error);
      return await msg.channel.send("很抱歉，处理您的请求时出现了问题。请稍后再试。");
    }
  }
}

// Handeling new messages
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const userId = msg.author.id;
  const channelId = msg.channel.id;
  const content = msg.content;
  const lowercaseContent = content.toLowerCase();
  const sessionKey = `${userId}-${channelId}`;
  
  // 检查是否为回复其他用户的消息
  const isReplyMessage = msg.reference && msg.reference.messageId;
  
  // 如果是回复，获取原始消息确认是否回复的是机器人
  let isReplyToBot = false;
  let repliedMessage = null;
  
  if (isReplyMessage) {
    try {
      repliedMessage = await msg.channel.messages.fetch(msg.reference.messageId);
      isReplyToBot = repliedMessage.author.id === client.user.id;
      console.log(`检测到回复消息 - 回复给机器人: ${isReplyToBot}`);
    } catch (error) {
      console.error("获取被回复消息时出错:", error);
    }
  }
  
  // 检查消息是否以"cc"或"小c"开头 - OpenAI触发
  const hasOpenAITrigger = lowercaseContent.startsWith("cc") || lowercaseContent.startsWith("小c");
  
  // 检查消息是否以"yy"或"小y"开头 - Gemini触发
  const hasGeminiTrigger = lowercaseContent.startsWith("yy") || lowercaseContent.startsWith("小y");
  
  // 获取当前会话信息
  const sessionData = userSessions.get(sessionKey);
  
  // 检查用户是否处于活跃会话中，并确定使用的模型
  let isInActiveSession = false;
  let useGeminiInSession = false;
  
  if (sessionData) {
    const now = Date.now();
    if (now - sessionData.lastActivity <= SESSION_TIMEOUT) {
      isInActiveSession = true;
      useGeminiInSession = sessionData.useGemini;
    } else {
      userSessions.delete(sessionKey);
    }
  }
  
  console.log(`消息处理: OpenAI前缀=${hasOpenAITrigger}, Gemini前缀=${hasGeminiTrigger}, 活跃会话=${isInActiveSession}, 是回复=${isReplyMessage}, 回复机器人=${isReplyToBot}`);
  
  // 如果消息有触发前缀 - 始终处理
  if (hasOpenAITrigger || hasGeminiTrigger) {
    // 显示正在输入的状态
    await msg.channel.sendTyping();
    
    // 确定使用的模型
    const useGemini = hasGeminiTrigger;
    
    // 提取不包含前缀的实际查询内容
    let query = "";
    if (lowercaseContent.startsWith("cc")) {
      query = content.slice(2).trim();
    } else if (lowercaseContent.startsWith("小c")) {
      query = content.slice(2).trim();
    } else if (lowercaseContent.startsWith("yy")) {
      query = content.slice(2).trim();
    } else if (lowercaseContent.startsWith("小y")) {
      query = content.slice(2).trim();
    }
    
    // 关键修改：无论是否在活跃会话中，始终根据前缀更新会话模型
    // 如果当前有活跃会话但模型类型不同，则强制更新会话的模型类型
    if (isInActiveSession && useGeminiInSession !== useGemini) {
      console.log(`检测到模型切换: 从 ${useGeminiInSession ? "Gemini" : "OpenAI"} 切换到 ${useGemini ? "Gemini" : "OpenAI"}`);
    }
    
    // 更新用户会话状态，标记为新会话或更新现有会话
    updateUserSession(userId, channelId, !isInActiveSession, useGemini);
    
    // 获取更新后的会话数据
    const updatedSessionData = userSessions.get(sessionKey);
    
    // 如果是新会话且没有通知过，添加会话模式提示
    if (updatedSessionData && updatedSessionData.isNewSession && !updatedSessionData.isNotified) {
      // 更新通知状态
      updatedSessionData.isNotified = true;
      userSessions.set(sessionKey, updatedSessionData);
      
      // 处理用户消息
      const response = await processUserMessage(msg, query, useGemini);
      
      // 如果返回为null，表示消息被其他处理器处理（如确认清除操作），直接返回
      if (response === null) return;
      
      // 添加会话模式提示
      if (response) {
        try {
          await response.react(useGemini ? GEMINI_EMOJI : SESSION_EMOJI);
        } catch (error) {
          console.error("添加emoji标记失败:", error);
        }
      }
    } else {
      // 处理用户消息
      const response = await processUserMessage(msg, query, useGemini);
      
      // 如果返回为null，表示消息被其他处理器处理（如确认清除操作），直接返回
      if (response === null) return;
      
      // 添加对应的模型标记
      if (response) {
        try {
          await response.react(useGemini ? GEMINI_EMOJI : SESSION_EMOJI);
        } catch (error) {
          console.error("添加emoji标记失败:", error);
        }
      }
    }
  } 
  // 检查是否在活跃会话中且不是回复其他用户的消息
  else if (isInActiveSession && (!isReplyMessage || isReplyToBot)) {
    // 如果消息内容看起来像是一个模型切换指令，但没有被前面的条件捕获
    // 这可能是因为在某些情况下前缀识别可能不正确，这里添加额外检查
    if (lowercaseContent.startsWith("cc") || lowercaseContent.startsWith("小c") || 
        lowercaseContent.startsWith("yy") || lowercaseContent.startsWith("小y")) {
      console.log("检测到可能的模型切换命令，但未被正确识别，重新发送消息");
      // 递归调用messageCreate事件处理，以便正确处理命令
      return client.emit("messageCreate", msg);
    }
    
    console.log(`用户在活跃会话中，处理无前缀消息，使用模型: ${useGeminiInSession ? "Gemini" : "OpenAI"}`);
    
    // 显示正在输入的状态
    await msg.channel.sendTyping();
    
    // 更新用户会话状态
    updateUserSession(userId, channelId, false, useGeminiInSession);
    
    // 直接将整个消息作为查询内容处理
    const response = await processUserMessage(msg, content, useGeminiInSession);
    
    // 如果返回为null，表示消息被其他处理器处理（如确认清除操作），直接返回
    if (response === null) return;
    
    // 添加会话模式标记
    if (response) {
      try {
        await response.react(useGeminiInSession ? GEMINI_EMOJI : SESSION_EMOJI);
      } catch (error) {
        console.error("添加emoji标记失败:", error);
      }
    }
  } 
  // 如果是在活跃会话中，但回复了非机器人消息，记录日志但不处理
  else if (isInActiveSession && isReplyMessage && !isReplyToBot) {
    console.log("用户在活跃会话中，但回复了其他用户，忽略消息");
    // 不处理此消息，但保持会话状态
    updateUserSession(userId, channelId, false, useGeminiInSession);
  }
  // 其他情况，忽略消息
  else {
    console.log("消息不满足处理条件，忽略");
  }
});

// 获取Gemini的随机活动想法
async function getGeminiActivityIdea() {
  console.log(`[${new Date().toISOString()}] 开始获取Gemini活动想法...`);
  try {
    // 更丰富的活动类型列表，每个类型带有更多具体例子
    const activityTypes = [
      { type: "游戏", prompt: "一个有趣的游戏活动", examples: ["打游戏", "玩LOL", "开黑", "打怪", "过关", "组队", "竞技场", "挑战赛", "冒险", "解谜"] },
      { type: "音乐", prompt: "一个关于听音乐的活动", examples: ["听音乐", "K歌", "摇滚", "听演唱会", "音乐创作", "作曲", "学乐器", "吉他", "DJ", "爵士"] },
      { type: "观看", prompt: "一个关于观看视频或内容的活动", examples: ["看视频", "看电影", "追剧", "刷短视频", "看直播", "纪录片", "看比赛", "看教程", "看展览", "观星"] },
      { type: "学习", prompt: "一个关于学习的活动", examples: ["学习", "看书", "写代码", "编程", "做笔记", "学语言", "做实验", "研究", "复习", "练习"] },
      { type: "创作", prompt: "一个关于创作内容的活动", examples: ["画画", "写作", "创作", "编曲", "拍照", "剪辑", "设计", "建模", "搭建", "手工"] },
      { type: "思考", prompt: "一个关于思考或冥想的状态", examples: ["冥想", "发呆", "构思", "策划", "思考", "分析", "总结", "反思", "梳理", "规划"] },
      { type: "运动", prompt: "一个关于体育或运动的活动", examples: ["跑步", "健身", "打球", "瑜伽", "爬山", "游泳", "骑行", "徒步", "跳舞", "拉伸"] },
      { type: "社交", prompt: "一个关于社交活动的状态", examples: ["聊天", "开会", "吹水", "团建", "聚会", "讨论", "派对", "网聚", "面基", "协作"] },
      { type: "竞赛", prompt: "一个关于参与竞赛的活动", examples: ["比赛", "竞技", "PK", "战斗", "竞争", "锦标赛", "决赛", "淘汰赛", "对决", "抢答"] },
      { type: "直播", prompt: "一个关于进行直播的活动", examples: ["直播", "解说", "评论", "连麦", "表演", "互动", "分享", "教学", "开箱", "测评"] },
      { type: "饮食", prompt: "一个关于吃喝的活动", examples: ["吃饭", "品茶", "烹饪", "做菜", "试新品", "下厨", "尝美食", "品咖啡", "做甜点", "宵夜"] },
      { type: "出行", prompt: "一个关于出行的活动", examples: ["旅行", "散步", "探险", "逛街", "郊游", "遛弯", "漫步", "城市探索", "打卡", "观光"] },
      { type: "购物", prompt: "一个关于购物的活动", examples: ["购物", "逛街", "剁手", "选购", "淘宝", "挑选", "比价", "囤货", "寻宝", "海淘"] },
      { type: "情绪", prompt: "一个有情绪色彩的状态", examples: ["开心", "沉思", "放松", "兴奋", "无聊", "感慨", "充电", "疗愈", "欢笑", "庆祝"] },
      { type: "娱乐", prompt: "一个娱乐休闲活动", examples: ["玩游戏", "看书", "烹饪", "园艺", "看风景", "收集", "养宠物", "装饰", "折纸", "解压"] },
      { type: "艺术", prompt: "一个艺术相关活动", examples: ["绘画", "书法", "雕塑", "摄影", "欣赏艺术", "写诗", "弹琴", "观展", "创意", "造型"] },
      { type: "科技", prompt: "一个科技相关活动", examples: ["研发", "调试", "升级", "测试", "修复", "探索科技", "组装", "开发", "实验", "创新"] },
      { type: "阅读", prompt: "一个阅读相关活动", examples: ["读书", "翻杂志", "看漫画", "学习资料", "古籍", "小说", "科普", "诗集", "论文", "评论"] },
      { type: "工作", prompt: "一个工作相关活动", examples: ["开会", "策划", "写方案", "汇报", "协作", "头脑风暴", "研讨", "答疑", "培训", "检查"] },
      { type: "家务", prompt: "一个家务相关活动", examples: ["整理", "打扫", "收纳", "洗衣", "做饭", "修理", "装饰", "改造", "布置", "养护"] }
    ];
    
    // 获取当前时间信息，帮助生成与时间相关的活动
    const now = new Date();
    const hours = now.getHours();
    const timeOfDay = 
      hours >= 5 && hours < 8 ? "早晨" :
      hours >= 8 && hours < 12 ? "上午" :
      hours >= 12 && hours < 14 ? "中午" :
      hours >= 14 && hours < 18 ? "下午" :
      hours >= 18 && hours < 22 ? "晚上" : "深夜";
    
    // 随机选择一个活动类型，但避免最近使用过的
    let randomType;
    let attempts = 0;
    const maxAttempts = 10; // 增加尝试次数，确保不重复
    
    do {
      randomType = activityTypes[Math.floor(Math.random() * activityTypes.length)];
      attempts++;
      // 如果尝试次数过多，就放弃避免重复的要求，防止死循环
      if (attempts >= maxAttempts) break;
    } while (RECENT_STATUSES.includes(randomType.type));
    
    console.log(`[${new Date().toISOString()}] 选择的活动类型: ${randomType.type}，尝试次数: ${attempts}`);
    
    // 记录所选活动类型到最近使用列表
    RECENT_STATUSES.push(randomType.type);
    if (RECENT_STATUSES.length > MAX_RECENT_STATUSES) {
      RECENT_STATUSES.shift();
    }
    
    // 随机选择是否使用Gemini或预设活动
    const usePreset = Math.random() < 0.25; // 降低到25%使用预设，增加多样性
    
    if (usePreset) {
      // 从预设例子中随机选择一个，但避免使用第一个例子，增加多样性
      const startIndex = Math.min(1, randomType.examples.length - 1); // 至少从索引1开始（如果有的话）
      const randomIndex = startIndex + Math.floor(Math.random() * (randomType.examples.length - startIndex));
      const presetActivity = randomType.examples[randomIndex];
      console.log(`[${new Date().toISOString()}] 使用预设活动: "${presetActivity}" (索引 ${randomIndex})`);
      return presetActivity;
    }
    
    // 构建提示，带有活动类型和时间背景信息，提供更多的可能性
    const prompt = `现在是${timeOfDay}，给我一个简短的、有创意的${randomType.type}类活动，用于Discord机器人的状态显示。

具体要求：
1. 活动内容要符合${randomType.prompt}
2. 表达积极情绪或幽默感
3. 必须是【具体活动】，而不是抽象词汇
4. 最好不超过4个汉字或6个英文单词
5. 请绝对避免使用"摸鱼"、"划水"、"躺平"等低效率的活动
6. 考虑${timeOfDay}这个时间点适合做什么
7. 尽量创新，不要重复常见活动
8. 活动可以有自己的特色，与众不同

以下是一些例子供参考：${randomType.examples.slice(0, 5).join("、")}

请直接回复活动内容，不要有任何解释或额外语句。`;
    
    console.log(`[${new Date().toISOString()}] 向Gemini请求${randomType.type}类活动想法，时间段：${timeOfDay}`);
    
    const chat = geminiModel.startChat({
      generationConfig: {
        temperature: 1.0, // 提高温度，增加创造性
        topP: 0.98,
        topK: 60, // 增加topK值
        maxOutputTokens: 50,
      }
    });
    
    console.log(`[${new Date().toISOString()}] 发送请求到Gemini API...`);
    const result = await chat.sendMessage(prompt);
    const activityText = result.response.text();
    
    // 移除可能的引号、句号和多余空格
    const cleanedText = activityText.replace(/["'.。！!?？]/g, '').trim();
    console.log(`[${new Date().toISOString()}] Gemini返回活动想法: "${activityText}" -> 清理后: "${cleanedText}"`);
    
    // 检查是否包含无趣词汇的列表更加全面
    const boringWords = ["摸鱼", "划水", "躺平", "发呆", "无所事事", "混日子", "玩手机", "打瞌睡", "摆烂", "犯困"];
    
    if (boringWords.some(word => cleanedText.includes(word))) {
      // 如果包含这些词，使用预设活动
      const randomIndex = Math.floor(Math.random() * randomType.examples.length);
      const presetActivity = randomType.examples[randomIndex];
      console.log(`[${new Date().toISOString()}] 检测到无聊词汇，改用预设活动: "${presetActivity}"`);
      return presetActivity;
    }
    
    // 检查活动长度，如果太短可能不够具体
    if (cleanedText.length < 2) {
      const presetActivity = randomType.examples[Math.floor(Math.random() * randomType.examples.length)];
      console.log(`[${new Date().toISOString()}] 活动太短，改用预设活动: "${presetActivity}"`);
      return presetActivity;
    }
    
    return cleanedText;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 获取Gemini活动想法失败:`, error);
    
    // 更丰富的与时间相关的默认活动
    const now = new Date();
    const hours = now.getHours();
    
    const morningActivities = ["晨跑", "读书", "冥想", "写作", "学习", "听播客", "做早餐", "晨练", "规划", "绘画", "笔记", "拉伸"];
    const noonActivities = ["午餐", "午休", "咖啡时间", "学习中", "会议", "冲刺", "头脑风暴", "计划", "整理", "审核", "讨论", "品茶"];
    const afternoonActivities = ["学习", "编程", "创作", "设计", "思考", "讨论", "规划", "开发", "测试", "调研", "总结", "演示"];
    const eveningActivities = ["晚餐", "锻炼", "放松", "聊天", "阅读", "看电影", "游戏时间", "散步", "创作", "音乐", "研究", "学习"];
    const nightActivities = ["冥想", "总结", "计划", "阅读", "听音乐", "睡前故事", "创作", "反思", "筹划", "记录", "思考", "整理"];
    
    let activities;
    if (hours >= 5 && hours < 9) activities = morningActivities;
    else if (hours >= 9 && hours < 14) activities = noonActivities; 
    else if (hours >= 14 && hours < 18) activities = afternoonActivities;
    else if (hours >= 18 && hours < 22) activities = eveningActivities;
    else activities = nightActivities;
    
    // 避免使用最近使用过的活动
    let availableActivities = activities.filter(activity => !RECENT_STATUSES.includes(activity));
    
    // 如果过滤后没有活动，则使用原始列表
    if (availableActivities.length === 0) {
      availableActivities = activities;
    }
    
    const defaultActivity = availableActivities[Math.floor(Math.random() * availableActivities.length)];
    console.log(`[${new Date().toISOString()}] 使用备用活动: "${defaultActivity}"`);
    
    // 记录所选活动到最近使用列表
    RECENT_STATUSES.push(defaultActivity);
    if (RECENT_STATUSES.length > MAX_RECENT_STATUSES) {
      RECENT_STATUSES.shift();
    }
    
    return defaultActivity;
  }
}

// 使用GPT-4o-mini提取关键词并生成状态描述
async function analyzeActivityWithGPT(activity) {
  console.log(`[${new Date().toISOString()}] 开始使用GPT分析活动: "${activity}"`);
  try {
    // 获取当前时间信息，作为上下文
    const now = new Date();
    const hours = now.getHours();
    const timeOfDay = 
      hours >= 5 && hours < 12 ? "早上" :
      hours >= 12 && hours < 18 ? "下午" :
      hours >= 18 && hours < 22 ? "晚上" : "深夜";
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `你是专门为Discord机器人优化状态显示的AI。
当前时间段：${timeOfDay}

你的任务是:
1. 分析输入的活动描述
2. 提取最具代表性的动词或活动名称
3. 转化为一个简短的Discord状态（不超过4个汉字/4-6个英文单词）
4. 确保状态适合"正在玩/听/看/直播/比赛"等动作前缀
5. 不要输出任何解释，只返回简洁的状态文本
6. 保留emoji（如果有的话）
7. 状态应该有趣、生动且表意明确`
        },
        {
          role: "user", 
          content: `为Discord机器人生成一个简洁状态，基于以下活动: "${activity}"`
        }
      ],
      temperature: 0.4,
      max_tokens: 25
    });
    
    const analyzed = response.choices[0].message.content.trim();
    console.log(`[${new Date().toISOString()}] GPT返回分析结果: "${analyzed}"`);
    
    // 移除可能的引号、句号和多余标点，但保留emoji
    const cleanResult = analyzed.replace(/["'.,!?。！？]/g, '').trim();
    
    // 如果结果太长，截断
    let finalResult = cleanResult;
    if (cleanResult.length > 20) {
      finalResult = cleanResult.substring(0, 20);
      console.log(`[${new Date().toISOString()}] 结果太长，截断: "${cleanResult}" -> "${finalResult}"`);
    }
    
    console.log(`[${new Date().toISOString()}] 最终GPT分析结果: "${finalResult}"`);
    return finalResult;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] GPT分析活动失败:`, error);
    const fallbackResult = activity.length > 20 ? activity.substring(0, 20) : activity;
    console.log(`[${new Date().toISOString()}] 使用原始活动作为后备: "${fallbackResult}"`);
    return fallbackResult;
  }
}

// 更新机器人状态
async function updateBotStatus() {
  console.log(`[${new Date().toISOString()}] 开始更新机器人状态...`);
  try {
    // 检查机器人状态
    if (!client.user) {
      console.error(`[${new Date().toISOString()}] 错误: client.user未定义，机器人可能未完全初始化`);
      return;
    }
    
    // 获取Gemini的活动想法
    const activityIdea = await getGeminiActivityIdea();
    console.log(`[${new Date().toISOString()}] Gemini提供的活动想法: "${activityIdea}"`);
    
    // 使用GPT-4o-mini分析并提取关键词
    const analyzedActivity = await analyzeActivityWithGPT(activityIdea);
    console.log(`[${new Date().toISOString()}] GPT分析后的活动: "${analyzedActivity}"`);
    
    // 随机选择一个emoji
    const randomEmoji = STATUS_EMOJI_LIST[Math.floor(Math.random() * STATUS_EMOJI_LIST.length)];
    
    // 根据活动内容选择状态类型
    const activityTypes = [
      { type: ActivityType.Playing, keywords: ["玩", "游戏", "打", "play", "game", "gaming"] },
      { type: ActivityType.Listening, keywords: ["听", "音乐", "歌", "listen", "music", "song"] },
      { type: ActivityType.Watching, keywords: ["看", "观看", "视频", "电影", "watch", "movie", "video"] },
      { type: ActivityType.Competing, keywords: ["比赛", "竞争", "竞技", "赛", "compete", "tournament"] },
      { type: ActivityType.Streaming, keywords: ["直播", "stream", "streaming", "broadcast", "live"] },
      { type: ActivityType.Custom, keywords: [] } // 默认类型
    ];
    
    // 检查活动关键词，确定状态类型
    let selectedActivityType = ActivityType.Custom;
    const lowerActivity = analyzedActivity.toLowerCase();
    
    for (const activityType of activityTypes) {
      for (const keyword of activityType.keywords) {
        if (lowerActivity.includes(keyword.toLowerCase())) {
          selectedActivityType = activityType.type;
          break;
        }
      }
      if (selectedActivityType !== ActivityType.Custom) break;
    }
    
    // 获取状态类型名称用于日志
    const activityTypeName = 
      selectedActivityType === ActivityType.Playing ? "正在玩" :
      selectedActivityType === ActivityType.Listening ? "正在听" :
      selectedActivityType === ActivityType.Watching ? "正在看" :
      selectedActivityType === ActivityType.Competing ? "正在比赛" :
      selectedActivityType === ActivityType.Streaming ? "正在直播" : "正在";
    
    const statusName = `${analyzedActivity} ${randomEmoji}`;
    console.log(`[${new Date().toISOString()}] 准备设置机器人状态: 类型=${activityTypeName}, 内容="${statusName}"`);
    
    // 设置机器人状态
    try {
      await client.user.setActivity({
        name: statusName,
        type: selectedActivityType
      });
      console.log(`[${new Date().toISOString()}] ✅ 机器人状态设置成功: ${activityTypeName} ${statusName}`);
    } catch (setActivityError) {
      console.error(`[${new Date().toISOString()}] ❌ 设置状态时出错:`, setActivityError);
      throw setActivityError;
    }
    
    // 保存状态历史到日志
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} | Gemini: "${activityIdea}" | GPT: "${analyzedActivity}" | 状态: "${activityTypeName} ${analyzedActivity} ${randomEmoji}"\n`;
    
    // 追加写入日志文件（异步）
    fs.appendFile('status_log.txt', logEntry, (err) => {
      if (err) console.error(`[${new Date().toISOString()}] 写入状态日志失败:`, err);
      else console.log(`[${new Date().toISOString()}] 状态记录已写入日志文件`);
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 更新机器人状态失败:`, error);
    // 设置一个默认状态
    try {
      console.log(`[${new Date().toISOString()}] 尝试设置默认状态...`);
      await client.user.setActivity({
        name: "思考人生 🤔",
        type: ActivityType.Playing
      });
      console.log(`[${new Date().toISOString()}] ✅ 默认状态设置成功`);
    } catch (defaultError) {
      console.error(`[${new Date().toISOString()}] ❌ 设置默认状态也失败:`, defaultError);
    }
  }
}
