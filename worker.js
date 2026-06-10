/**
 * Telegram 双向机器人 Cloudflare Worker
 * 实现了：人机验证、私聊到话题模式的转发、管理员回复中继、话题名动态更新、已编辑消息处理、用户屏蔽功能、关键词自动回复
 * 新增：用户/管理员编辑消息双向同步（用户编辑→管理侧原消息+提醒；管理员编辑→用户侧原消息无提醒）
 * 修复：原始信息永久保留第一次发送的内容，不被后续编辑覆盖
 * 调整：屏蔽/解除屏蔽向用户发送提醒；用户资料卡移除首次连接时间并去除<code>标签
 * 优化：删除未使用的首次连接时间存储逻辑，清理冗余参数
 * 修复：语法错误、落地话题名动态管理功能
 * 优化：删除冗余的`latest_msg_data` KV存储，减少写入次数
 */

// --- 辅助函数 ---

function escapeHtml(text) {
  if (!text) return '';
  return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

function getUserInfo(user) {
  const userId = user.id.toString();
  const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
  const rawUsername = user.username ? `@${user.username}` : "无";
  
  const safeName = escapeHtml(rawName);
  const safeUsername = escapeHtml(rawUsername);
  const safeUserId = escapeHtml(userId);
  const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);
  
  // 移除<code>标签，符合用户要求
  const infoCard = `
<b>👤 用户资料卡</b>
---
• 昵称/名称: ${safeName}
• 用户名: ${safeUsername}
• ID: ${safeUserId}
  `.trim();

  return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}

function getActionButton(userId, isBlocked) {
  const action = isBlocked ? "unblock" : "block";
  const text = isBlocked ? "✅ 解除屏蔽 (Unblock)" : "🚫 屏蔽此人 (Block)";
  return {
      inline_keyboard: [[{
          text: text,
          callback_data: `${action}:${userId}`
      }]]
  };
}

function parseKeywordResponses(envValue) {
  if (!envValue) return [];
  const rules = [];
  const lines = envValue.split('\n');

  for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

      const parts = trimmedLine.split('===');
      if (parts.length === 2) {
          const keywords = parts[0].trim();
          const response = parts[1].trim();
          if (keywords && response) {
              try {
                  const regex = new RegExp(keywords, 'gi');
                  rules.push({ regex, response });
              } catch (e) {
                  console.error("Invalid RegExp in KEYWORD_RESPONSES:", keywords, e);
              }
          }
      }
  }
  return rules;
}

function parseBlockKeywords(envValue) {
  if (!envValue) return [];
  const rules = [];
  const lines = envValue.split('\n');

  for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

      try {
          const regex = new RegExp(trimmedLine, 'gi');
          rules.push(regex);
      } catch (e) {
          console.error("Invalid RegExp in BLOCK_KEYWORDS:", trimmedLine, e);
      }
  }
  return rules;
}

async function telegramApi(token, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${token}/${methodName}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    });

    let data;
    try {
        data = await response.json();
    } catch (e) {
        console.error(`Telegram API ${methodName} 返回非 JSON 响应`, e);
        throw new Error(`Telegram API ${methodName} returned non-JSON response`);
    }

    if (!data.ok) {
        console.error(`Telegram API error (${methodName}): ${data.description}. Params: ${JSON.stringify(params)}. Full response:`, data);
        throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
    }

    return data.result;
}

// --- 核心更新处理函数 ---

export default {
  async fetch(request, env, ctx) {
      if (request.method === "POST") {
          try {
              const update = await request.json();
              ctx.waitUntil(handleUpdate(update, env));
          } catch (e) {
              console.error("处理更新时出错:", e);
          }
      }
      return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  if (update.message) {
      if (update.message.chat.type === "private") {
          await handlePrivateMessage(update.message, env);
      } else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) {
          await handleAdminReply(update.message, env);
      }
  } else if (update.edited_message) {
      if (update.edited_message.chat.type === "private") {
          await handleRelayEditedMessage(update.edited_message, env);
      } else if (update.edited_message.chat.id.toString() === env.ADMIN_GROUP_ID) {
          await handleAdminEditReply(update.edited_message, env);
      }
  } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
  }
}

async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id.toString();
  const text = message.text || "";
  const userId = chatId;

  // 检查屏蔽状态
  const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${chatId}`) === "true";
  if (isBlocked) return; 

  // 处理 /start 或 /help
  if (text === "/start" || text === "/help") {
      await handleStart(chatId, env);
      return;
  }

  // 检查验证状态
  const userState = (await env.TG_BOT_KV.get(`user_state:${chatId}`)) || "new";
  if (userState === "pending_verification") {
      await handleVerification(chatId, text, env);
  } else if (userState === "verified") {
      // 关键词屏蔽检查
      const blockKeywordsValue = env.BLOCK_KEYWORDS;
      const blockThreshold = parseInt(env.BLOCK_THRESHOLD, 10) || 5; 
      
      if (blockKeywordsValue && text) { 
          const blockRules = parseBlockKeywords(blockKeywordsValue);
          for (const regex of blockRules) {
              if (regex.test(text)) {
                  let currentCount = parseInt(await env.TG_BOT_KV.get(`block_count:${userId}`) || 0, 10);
                  currentCount += 1;
                  await env.TG_BOT_KV.put(`block_count:${userId}`, currentCount.toString());
                  
                  const blockNotification = `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold}次)，此消息已被丢弃，不会转发给对方。`;
                  if (currentCount >= blockThreshold) {
                      await env.TG_BOT_KV.put(`is_blocked:${userId}`, "true");
                      const autoBlockMessage = `❌ 您已多次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`;
                      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoBlockMessage });
                      return;
                  }
                  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                  return; 
              }
          }
      }

      // 转发内容过滤检查
      const filters = {
          image: (env.ENABLE_IMAGE_FORWARDING || 'true').toLowerCase() === 'true',
          link: (env.ENABLE_LINK_FORWARDING || 'true').toLowerCase() === 'true',
          text: (env.ENABLE_TEXT_FORWARDING || 'true').toLowerCase() === 'true',
          channel: (env.ENABLE_CHANNEL_FORWARDING || 'true').toLowerCase() === 'true',
      };

      let isForwardable = true;
      let filterReason = '';
      const hasLinks = (msg) => {
          const entities = msg.entities || msg.caption_entities || [];
          return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
      };

      if (message.forward_from_chat && message.forward_from_chat.type === 'channel') {
          if (!filters.channel) { isForwardable = false; filterReason = '频道转发内容'; }
      } else if (message.photo) {
          if (!filters.image) { isForwardable = false; filterReason = '图片/照片'; }
      } 
      
      if (isForwardable && hasLinks(message)) {
          if (!filters.link) {
              isForwardable = false;
              filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
          }
      }

      const isPureText = message.text && !message.photo && !message.video && !message.document && !message.sticker && !message.audio && !message.voice && !message.forward_from_chat;
      if (isForwardable && isPureText) {
          if (!filters.text) { isForwardable = false; filterReason = '纯文本内容'; }
      }

      if (!isForwardable) {
          const filterNotification = `此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`;
          await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: filterNotification });
          return;
      }
      
      // 关键词自动回复检查
      const keywordResponsesValue = env.KEYWORD_RESPONSES;
      if (keywordResponsesValue && text) { 
          const autoResponseRules = parseKeywordResponses(keywordResponsesValue);
          for (const rule of autoResponseRules) {
              if (rule.regex.test(text)) {
                  const autoReplyPrefix = "此消息为自动回复\n\n";
                  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoReplyPrefix + rule.response });
                  return; 
              }
          }
      }
      
      // 转发到管理话题
      await handleRelayToTopic(message, env);
      
  } else {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "请使用 /start 命令开始。" });
  }
}

// --- 验证逻辑 ---

async function handleStart(chatId, env) {
  const welcomeMessage = env.WELCOME_MESSAGE || "欢迎！在使用之前，请先完成人机验证。";
  const defaultVerificationQuestion = 
      "问题：1+1=?\n\n" +
      "提示：\n" +
      "1. 正确答案不是“2”。\n" +
      "2. 答案在机器人简介内，请看简介的答案进行回答。";
  const verificationQuestion = env.VERIFICATION_QUESTION || defaultVerificationQuestion;

  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
  await env.TG_BOT_KV.put(`user_state:${chatId}`, "pending_verification");
}

async function handleVerification(chatId, answer, env) {
  const expectedAnswer = env.VERIFICATION_ANSWER || "3"; 

  if (answer === expectedAnswer) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "✅ 验证通过！您现在可以发送消息了。" });
      await env.TG_BOT_KV.put(`user_state:${chatId}`, "verified");
  } else {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "❌ 验证失败！\n请查看机器人简介查找答案，然后重新回答。" });
  }
}

async function handleRelayToTopic(message, env) {
    const { from: user } = message;
    const { userId, name, username, topicName, infoCard } = getUserInfo(user);
    let topicId = await env.TG_BOT_KV.get(`user_topic:${userId}`);
    const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${userId}`) === "true";

    const createTopicForUser = async () => {
        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: topicName,
            });
            const newTopicId = newTopic.message_thread_id.toString();

            await env.TG_BOT_KV.put(`user_topic:${userId}`, newTopicId);
            await env.TG_BOT_KV.put(`topic_user:${newTopicId}`, userId);

            // 存储用户资料（无首次连接时间）
            const newInfo = { name, username };
            await env.TG_BOT_KV.put(`user_info:${userId}`, JSON.stringify(newInfo));

            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                text: infoCard,
                message_thread_id: newTopicId,
                parse_mode: "HTML",
                reply_markup: getActionButton(userId, isBlocked),
            });

            return newTopicId;
        } catch (e) {
            console.error("createTopicForUser 创建话题失败:", e?.message || e);
            throw e;
        }
    };

    if (!topicId) {
        try {
            topicId = await createTopicForUser();
        } catch (e) {
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法连接（创建话题失败）。请稍后再试。",
            });
            return;
        }
    } else {
        // 落地“话题名动态管理”：检测用户资料变化
        const storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
        const storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : {};
        
        if (storedInfo.name !== name || storedInfo.username !== username) {
            const newTopicName = `${name.trim()} | ${userId}`.substring(0, 128);
            await updateTopicAndSendCard(user, topicId, name, username, newTopicName, env);
            // 更新存储的用户资料
            await env.TG_BOT_KV.put(`user_info:${userId}`, JSON.stringify({ name, username }));
        }
    }

    const tryCopyToTopic = async (targetTopicId) => {
        try {
            const result = await telegramApi(env.BOT_TOKEN, "copyMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                from_chat_id: userId,
                message_id: message.message_id,
                message_thread_id: targetTopicId,
            });
            return result;
        } catch (e) {
            console.error(`tryCopyToTopic 到话题 ${targetTopicId} 失败:`, e?.message || e);
            throw e;
        }
    };

    try {
        const copyResult = await tryCopyToTopic(topicId);
        // 存储用户消息ID→管理侧消息ID的映射（用于后续编辑同步）
        await env.TG_BOT_KV.put(
            `user_msg_to_admin:${userId}:${message.message_id}`,
            copyResult.message_id.toString()
        );
    } catch (e) {
        try {
            await env.TG_BOT_KV.delete(`user_topic:${userId}`);
            if (topicId) await env.TG_BOT_KV.delete(`topic_user:${topicId}`);

            const newTopicId = await createTopicForUser();
            try {
                const copyResult = await tryCopyToTopic(newTopicId);
                await env.TG_BOT_KV.put(
                    `user_msg_to_admin:${userId}:${message.message_id}`,
                    copyResult.message_id.toString()
                );
            } catch (e2) {
                console.error("尝试将消息复制到新话题也失败:", e2?.message || e2);
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "抱歉，消息转发失败（请稍后再试或联系管理员）。",
                });
                return;
            }
        } catch (createErr) {
            console.error("在处理话题失效时，创建新话题失败:", createErr?.message || createErr);
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法创建新的话题（请稍后再试）。",
            });
            return;
        }
    }

    // 存储原始内容到msg_data，永远不更新！
    if (message.text) {
        const messageData = { text: message.text, date: message.date };
        await env.TG_BOT_KV.put(`msg_data:${userId}:${message.message_id}`, JSON.stringify(messageData));
    }
}

async function handleRelayEditedMessage(editedMessage, env) {
  const { from: user, message_id: userMsgId } = editedMessage;
  const userId = user.id.toString();
  const topicId = await env.TG_BOT_KV.get(`user_topic:${userId}`);
  if (!topicId) return;

  const kvKey = `msg_data:${userId}:${userMsgId}`;
  const storedDataJson = await env.TG_BOT_KV.get(kvKey);
  let originalText = "[原始内容无法获取/非文本内容]";
  if (storedDataJson) {
    const storedData = JSON.parse(storedDataJson);
    originalText = storedData.text || originalText; // 永远读取第一次的原始内容
  } else return;

  const newContent = editedMessage.text || editedMessage.caption || "[非文本/媒体说明内容]";
  
  // 1. 更新管理侧用户原消息（1→2→3，永远同步最新内容）
  const adminMsgKey = `user_msg_to_admin:${userId}:${userMsgId}`;
  const adminMsgId = await env.TG_BOT_KV.get(adminMsgKey);
  if (adminMsgId) {
    try {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: parseInt(adminMsgId, 10),
        text: newContent,
        message_thread_id: topicId,
      });
    } catch (e) {
      console.error("更新管理侧用户原消息失败:", e.message);
    }
  }

  // 2. 复用同一条提醒消息（仅更新修改后的内容，原始信息永远不变）
  const noticeKey = `edit_notice:${userId}:${userMsgId}`;
  const existingNoticeId = await env.TG_BOT_KV.get(noticeKey);
  const notificationText = `
⚠️ <b>用户消息已修改</b>
---
<b>原始信息:</b> 
<code>${escapeHtml(originalText)}</code>

<b>修改后的新内容:</b>
<code>${escapeHtml(newContent)}</code>
  `.trim();

  try {
    if (existingNoticeId) {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: parseInt(existingNoticeId, 10),
        text: notificationText,
        parse_mode: "HTML",
        message_thread_id: topicId,
      });
    } else {
      const sentNotice = await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: notificationText,
        parse_mode: "HTML",
        message_thread_id: topicId,
      });
      await env.TG_BOT_KV.put(noticeKey, sentNotice.message_id.toString());
    }

    // ✅ 已删除冗余的 latest_msg_data 存储逻辑，减少 KV 写入
  } catch (e) {
    console.error("处理已编辑消息失败:", e.message);
  }
}

async function updateTopicAndSendCard(user, topicId, newName, newUsername, newTopicName, env) {
  const { userId, infoCard: newInfoCard } = getUserInfo(user);  
  try {
      const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${userId}`) === "true";
      await telegramApi(env.BOT_TOKEN, "editForumTopic", {
          chat_id: env.ADMIN_GROUP_ID,
          message_thread_id: topicId,
          name: newTopicName,
      });

      const updateNotification = `🔔 <b>用户资料已更新</b>\n话题名称已自动更新。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: updateNotification,
          message_thread_id: topicId,
          parse_mode: "HTML",
      });

      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: newInfoCard,
          message_thread_id: topicId,
          parse_mode: "HTML",
          reply_markup: getActionButton(userId, isBlocked),
      });
  } catch (e) {
      console.error(`更新话题或发送信息卡失败 (Topic ID: ${topicId}):`, e.message);
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const { data, message } = callbackQuery;
  const [action, userId] = data.split(':');  
  if (message.chat.id.toString() !== env.ADMIN_GROUP_ID) return; 

  await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: `执行动作: ${action === 'block' ? '屏蔽' : '解除屏蔽'}...`,
      show_alert: false 
  });

  if (action === 'block') {
      await handleBlockUser(userId, message, env);
  } else if (action === 'unblock') {
      await handleUnblockUser(userId, message, env);
  }
}

async function handleBlockUser(userId, message, env) {
  try {
      await env.TG_BOT_KV.put(`is_blocked:${userId}`, "true");
      const storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
      const storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : {};
      const userName = storedInfo.name || `User ${userId}`;
      
      const newMarkup = getActionButton(userId, true);
      await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: newMarkup,
      });
      
      const confirmation = `❌ **用户 [${userName}] 已被屏蔽。**\n机器人将不再接收此人消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: confirmation,
          message_thread_id: message.message_thread_id,
          parse_mode: "Markdown",
      });
      
      // 向用户发送屏蔽提醒
      const userNotification = `❌ 您已被屏蔽，机器人将不再接收您的消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: userId,
          text: userNotification,
      });
      
  } catch (e) {
      console.error("处理屏蔽操作失败:", e.message);
  }
}

async function handleUnblockUser(userId, message, env) {
  try {
      await env.TG_BOT_KV.delete(`is_blocked:${userId}`);
      await env.TG_BOT_KV.delete(`block_count:${userId}`);
      
      const storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
      const storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : {};
      const userName = storedInfo.name || `User ${userId}`;
      
      const newMarkup = getActionButton(userId, false);
      await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: newMarkup,
      });

      const confirmation = `✅ **用户 [${userName}] 已解除屏蔽。**\n机器人现在可以正常接收其消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: confirmation,
          message_thread_id: message.message_thread_id,
          parse_mode: "Markdown",
      });

      // 向用户发送解除屏蔽提醒
      const userNotification = `✅ 您已解除屏蔽，机器人现在可以正常接收您的消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: userId,
          text: userNotification,
      });

  } catch (e) {
      console.error("处理解除屏蔽操作失败:", e.message);
  }
}

async function handleAdminReply(message, env) {
    if (!message.is_topic_message || !message.message_thread_id) return;
    if (message.chat.id.toString() !== env.ADMIN_GROUP_ID) return;
    if (message.from && message.from.is_bot) return;

    const topicId = message.message_thread_id.toString();
    const userId = await env.TG_BOT_KV.get(`topic_user:${topicId}`);
    if (!userId) return;

    try {
        let userMessageId;

        if (message.text) {
            const result = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: message.text,
            });
            userMessageId = result.message_id;
        } else {
            const result = await telegramApi(env.BOT_TOKEN, "copyMessage", {
                chat_id: userId,
                from_chat_id: message.chat.id,
                message_id: message.message_id,
            });
            userMessageId = result.message_id;
        }

        // 存储管理员消息ID→用户消息ID的映射（用于后续编辑同步）
        const adminMsgKey = `admin_reply:${topicId}:${message.message_id}`;
        await env.TG_BOT_KV.put(adminMsgKey, userMessageId.toString());

    } catch (e) {
        console.error("handleAdminReply 失败:", e.message);
        try {
            if (message.photo && message.photo.length) {
                const fileId = message.photo[message.photo.length - 1].file_id;
                await telegramApi(env.BOT_TOKEN, "sendPhoto", {
                    chat_id: userId,
                    photo: fileId,
                    caption: message.caption || "",
                });
            } else if (message.document) {
                await telegramApi(env.BOT_TOKEN, "sendDocument", {
                    chat_id: userId,
                    document: message.document.file_id,
                    caption: message.caption || "",
                });
            } else if (message.video) {
                await telegramApi(env.BOT_TOKEN, "sendVideo", {
                    chat_id: userId,
                    video: message.video.file_id,
                    caption: message.caption || "",
                });
            } else if (message.audio) {
                await telegramApi(env.BOT_TOKEN, "sendAudio", {
                    chat_id: userId,
                    audio: message.audio.file_id,
                    caption: message.caption || "",
                });
            } else if (message.voice) {
                await telegramApi(env.BOT_TOKEN, "sendVoice", {
                    chat_id: userId,
                    voice: message.voice.file_id,
                    caption: message.caption || "",
                });
            } else if (message.sticker) {
                await telegramApi(env.BOT_TOKEN, "sendSticker", {
                    chat_id: userId,
                    sticker: message.sticker.file_id,
                });
            } else if (message.animation) {
                await telegramApi(env.BOT_TOKEN, "sendAnimation", {
                    chat_id: userId,
                    animation: message.animation.file_id,
                    caption: message.caption || "",
                });
            } else {
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "管理员发送了机器人无法直接转发的内容（例如投票或某些特殊媒体）。",
                });
            }
        } catch (e2) {
            console.error("handleAdminReply fallback also failed:", e2?.message || e2);
        }
    }
}

async function handleAdminEditReply(editedMessage, env) {
  const { message_id: adminMsgId, message_thread_id: topicId } = editedMessage;
  const topicIdStr = topicId.toString();

  const userId = await env.TG_BOT_KV.get(`topic_user:${topicIdStr}`);
  const adminMsgKey = `admin_reply:${topicIdStr}:${adminMsgId}`;
  const userMsgId = await env.TG_BOT_KV.get(adminMsgKey);
  
  if (!userId || !userMsgId) return;

  try {
    if (editedMessage.text) {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: userId,
        message_id: parseInt(userMsgId, 10),
        text: editedMessage.text,
      });
    } else if (editedMessage.caption) {
      await telegramApi(env.BOT_TOKEN, "editMessageCaption", {
        chat_id: userId,
        message_id: parseInt(userMsgId, 10),
        caption: editedMessage.caption,
      });
    }
  } catch (e) {
    console.error("同步管理员编辑失败:", e.message);
  }
}
