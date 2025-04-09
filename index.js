// Import dotenv, discordJS and openai
require("dotenv").config();
const { Client, IntentsBitField, PermissionsBitField, ChannelType } = require("discord.js");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

// 用户会话跟踪
const userSessions = new Map();
const SESSION_TIMEOUT = 30000; // 30秒会话超时
const SESSION_EMOJI = "💬"; // 会话状态emoji标记

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

// Discord Config
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
client.on("ready", () => console.log("Bot is online!"));
client.login(process.env.Discord_Token);

// OpenAi Config
const openai = new OpenAI({
  apiKey: process.env.OpenAI_API,
});

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

// 用户聊天记忆相关函数
const MEMORY_EXPIRATION = 60 * 60 * 24 * 30; // 聊天记忆保存30天

// 保存用户消息到Redis
async function saveUserMessage(userId, content) {
  try {
    const key = `chat:${userId}:messages`;
    const message = {
      role: "user",
      content,
      timestamp: Date.now()
    };
    
    // 获取当前的消息历史
    const currentHistory = await getUserChatHistory(userId);
    
    // 添加新消息
    currentHistory.push(message);
    
    // 如果历史消息超过20条，删除最早的消息
    if (currentHistory.length > 20) {
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
async function saveAIResponse(userId, content) {
  try {
    const key = `chat:${userId}:messages`;
    const message = {
      role: "assistant",
      content,
      timestamp: Date.now()
    };
    
    // 获取当前的消息历史
    const currentHistory = await getUserChatHistory(userId);
    
    // 添加新消息
    currentHistory.push(message);
    
    // 如果历史消息超过20条，删除最早的消息
    if (currentHistory.length > 20) {
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
    const key = `chat:${userId}:messages`;
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
    const key = `chat:${userId}:messages`;
    await redisClient.del(key);
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
function updateUserSession(userId, channelId, isNewSession = false) {
  const sessionKey = `${userId}-${channelId}`;
  const now = Date.now();
  
  // 获取现有会话或创建新会话
  const existingSession = userSessions.get(sessionKey) || {};
  
  // 更新会话数据
  userSessions.set(sessionKey, {
    lastActivity: now,
    isNotified: existingSession.isNotified || false, // 是否已通知会话模式
    startTime: existingSession.startTime || now, // 会话开始时间
    isNewSession: isNewSession // 是否是新会话
  });
  
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

// 清除频道内容
async function clearChannelMessages(channel, msg) {
  try {
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
      return channel.send(`已成功清除 <#${channel.id}> 中的 ${deletedCount} 条消息。`);
      
    } catch (error) {
      // 用户没有在指定时间内确认
      if (error instanceof Map) {
        return msg.channel.send("操作已取消：没有收到确认回复。");
      } else {
        console.error("清除消息时发生错误:", error);
        return msg.channel.send("清除消息时发生错误，请稍后再试。");
      }
    }
  } catch (error) {
    console.error("执行清除命令时出错:", error);
    // 创建新消息而不是回复
    return channel.send("执行清除命令时发生错误，请稍后再试。");
  }
}

// 清除用户记忆功能
async function clearUserMemory(msg) {
  try {
    const userId = msg.author.id;
    
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
      
      if (success) {
        return msg.reply("已成功清除我们之间的所有聊天记忆。从现在开始，我们可以开始新的对话了。如果您有任何问题，随时都可以问我！");
      } else {
        return msg.reply("抱歉，清除聊天记忆时出现了技术问题。请稍后再试一次。如果问题持续存在，请联系管理员。");
      }
      
    } catch (error) {
      // 用户没有在指定时间内确认
      if (error instanceof Map) {
        return msg.channel.send("操作已取消：没有收到确认回复。");
      } else {
        console.error("清除聊天记忆时发生错误:", error);
        return msg.channel.send("清除聊天记忆时发生错误，请稍后再试。");
      }
    }
  } catch (error) {
    console.error("执行清除聊天记忆命令时出错:", error);
    return msg.reply("执行清除命令时发生错误，请稍后再试。");
  }
}

// 处理用户消息函数
async function processUserMessage(msg, query) {
  try {
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
    let ConvoLog = [{ role: "system", content: "Discord Chat Bot" }];

    // 从Redis获取用户聊天历史
    const userId = msg.author.id;
    const userHistory = await getUserChatHistory(userId);
    
    // 将用户历史消息添加到对话记录中
    if (userHistory && userHistory.length > 0) {
      userHistory.forEach(message => {
        ConvoLog.push({
          role: message.role,
          content: message.content
        });
      });
    }
    
    // 保存当前用户消息到Redis
    await saveUserMessage(userId, query);
    
    // 添加当前查询
    ConvoLog.push({
      role: "user",
      content: query
    });

    let response;
    
    // 如果知识库中有匹配的内容，将其添加到系统提示中
    if (knowledgeAnswer) {
      console.log("在知识库中找到匹配的答案:", knowledgeAnswer);
      
      // 将知识库答案添加到系统提示中
      ConvoLog[0].content += `\n\n请参考以下知识库中的信息回答用户问题：\n${knowledgeAnswer}`;
      
      // 获取AI回答
      response = await createChatCompletionWithRetry(ConvoLog);
    } else {
      // 没有匹配项，直接使用AI回答
      response = await createChatCompletionWithRetry(ConvoLog);
    }

    // 获取AI回复内容
    const aiReplyContent = response.choices[0].message.content;
    
    // 保存AI回复到用户历史
    await saveAIResponse(userId, aiReplyContent);
    
    try {
      // 尝试回复消息，如果失败则发送新消息
      return await msg.reply(aiReplyContent);
    } catch (error) {
      console.error("回复消息失败，尝试发送新消息:", error);
      return await msg.channel.send(aiReplyContent);
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
  
  // 检查消息是否以"cc"或"小c"开头
  const hasTriggerPrefix = lowercaseContent.startsWith("cc") || lowercaseContent.startsWith("小c");
  
  // 检查用户是否处于活跃会话中
  const isInActiveSession = isUserInActiveSession(userId, channelId);
  
  console.log(`消息处理: 前缀=${hasTriggerPrefix}, 活跃会话=${isInActiveSession}, 是回复=${isReplyMessage}, 回复机器人=${isReplyToBot}`);
  
  // 如果消息有触发前缀 - 始终处理
  if (hasTriggerPrefix) {
    // 显示正在输入的状态
      await msg.channel.sendTyping();
    
    // 提取不包含前缀的实际查询内容
    let query = "";
    if (lowercaseContent.startsWith("cc")) {
      query = content.slice(2).trim();
    } else if (lowercaseContent.startsWith("小c")) {
      query = content.slice(2).trim();
    }
    
    // 更新用户会话状态，标记为新会话
    updateUserSession(userId, channelId, true);
    
    // 获取会话数据
    const sessionData = userSessions.get(sessionKey);
    
    // 如果是新会话且没有通知过，添加会话模式提示
    if (sessionData && sessionData.isNewSession && !sessionData.isNotified) {
      // 更新通知状态
      sessionData.isNotified = true;
      userSessions.set(sessionKey, sessionData);
      
      // 处理用户消息
      const response = await processUserMessage(msg, query);
      
      // 添加会话模式提示
      if (response) {
        try {
          await response.react(SESSION_EMOJI);
        } catch (error) {
          console.error("添加会话emoji标记失败:", error);
        }
      }
    } else {
      // 处理用户消息
      await processUserMessage(msg, query);
    }
  } 
  // 检查是否在活跃会话中且不是回复其他用户的消息
  else if (isInActiveSession && (!isReplyMessage || isReplyToBot)) {
    console.log("用户在活跃会话中，处理无前缀消息");
    
    // 显示正在输入的状态
    await msg.channel.sendTyping();
    
    // 更新用户会话状态
    updateUserSession(userId, channelId, false);
    
    // 直接将整个消息作为查询内容处理
    const response = await processUserMessage(msg, content);
    
    // 添加会话模式标记
    if (response) {
      try {
        await response.react(SESSION_EMOJI);
      } catch (error) {
        console.error("添加会话emoji标记失败:", error);
      }
    }
  } 
  // 如果是在活跃会话中，但回复了非机器人消息，记录日志但不处理
  else if (isInActiveSession && isReplyMessage && !isReplyToBot) {
    console.log("用户在活跃会话中，但回复了其他用户，忽略消息");
    // 不处理此消息，但保持会话状态
    updateUserSession(userId, channelId, false);
  }
  // 其他情况，忽略消息
  else {
    console.log("消息不满足处理条件，忽略");
  }
});
