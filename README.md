# GPT-4o Mini Discord 聊天机器人

这是一个基于 OpenAI GPT-4o Mini 模型的 Discord 聊天机器人，具有会话管理、知识库查询和聊天历史记录等功能。

## 功能特点

- 🤖 基于 OpenAI GPT-4o Mini 模型的智能对话
- 💬 支持会话模式（无需重复输入触发词）
- 📚 集成知识库查询功能
- 🔄 自动保存聊天历史（使用 Redis）
- 🎯 支持多种触发方式（"cc" 或 "小c" 前缀）
- 🧹 支持清除聊天历史和频道消息
- 🔒 完善的权限管理和错误处理

## 安装说明

1. 克隆仓库到本地：
   ```bash
   git clone https://github.com/yourusername/chatgpt-discord-chat-bot.git
   ```

2. 安装依赖：
   ```bash
   npm install
   ```

3. 配置环境变量：
   在项目根目录创建 `.env` 文件，添加以下内容：
   ```
   Discord_Token=<你的Discord机器人令牌>
   OpenAI_API=<你的OpenAI API密钥>
   REDIS_URL=<你的Redis连接URL>（可选，默认为redis://localhost:6379）
   ```

4. 配置知识库：
   在 `knowledge.json` 文件中添加你的知识库内容，格式如下：
   ```json
   {
     "questions": [
       {
         "keywords": ["关键词1", "关键词2"],
         "answer": "对应的答案"
       }
     ]
   }
   ```

5. 启动机器人：
   ```bash
   node index.js
   ```

## 使用说明

### 基本对话
- 使用 "cc" 或 "小c" 前缀开始对话
- 在活跃会话中可以直接发送消息（无需前缀）
- 会话超时时间为 30 秒

### 特殊命令
- 清除聊天记忆：发送包含"清除记忆"、"忘记历史"等关键词的消息
- 清除频道消息：发送包含"清除内容"、"清理频道"等关键词的消息（需要管理员权限）

### 会话模式
- 使用前缀开始对话后，机器人会进入会话模式
- 会话模式下直接发送消息即可继续对话
- 会话超时后需要重新使用前缀开始新对话

## 技术栈

- Node.js
- Discord.js
- OpenAI API
- Redis
- dotenv

## 依赖项

```json
{
  "dependencies": {
    "discord.js": "^14.18.0",
    "dotenv": "^16.4.5",
    "openai": "^4.91.0",
    "redis": "^4.7.0"
  }
}
```

## 注意事项

1. 确保机器人具有以下权限：
   - 发送消息
   - 读取消息
   - 管理消息（用于清除频道功能）

2. 清除频道消息功能需要用户具有"管理消息"权限

3. 建议定期备份 Redis 数据

## 许可证

ISC

## 贡献

欢迎提交 Issue 和 Pull Request 来帮助改进这个项目。

## 致谢

- OpenAI
- Discord.js
- Redis

**#Made with 🤍 by [Githmin Jayawardhana](https://github.com/githmin)** 