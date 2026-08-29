/**
 * NG 消息事件 → TRSS 形状的包装
 *
 * apps/checkin.js 里 1100 行指令逻辑用的是 TRSS 那套字段名（e.user_id、e.group_id、
 * e.member.is_admin、e.group.recallMsg…）。与其把这些逻辑改一遍（改一遍就要维护两份），
 * 不如在这里把 NG 事件翻译成同一形状：翻译只有几十行，且两个宿主的行为差异集中可见。
 */

/**
 * 把 NG 的 SendResult 转成 TRSS 形状。绑定流程要拿 message_id 去撤回群里的提示消息，
 * 字段名不一致会让撤回静默失效（不报错、消息也不消失）
 * @param {object} res NG 发送结果
 * @returns {object} 带 message_id 的结果
 */
function toTrssSendResult(res) {
  if (!res || typeof res !== 'object') return res
  return { ...res, message_id: res.messageId ?? res.message_id ?? null }
}

/**
 * 按 TRSS 的 reply 签名回复
 * @param {object} e NG 消息事件
 * @param {any} content 消息内容（字符串 / NG 消息段 / 数组）
 * @param {boolean} quote 是否引用原消息
 * @param {{recallMsg?: number, at?: boolean}} opts TRSS 的第三参，recallMsg 单位是秒
 * @returns {Promise<object>} 发送结果
 */
async function replyAsTrss(e, content, quote = false, opts = {}) {
  const options = {}
  if (quote) options.quote = true
  if (opts?.at) options.at = true
  // TRSS 的 recallMsg 是秒，NG 的 recallAfter 是毫秒
  if (Number(opts?.recallMsg) > 0) options.recallAfter = Number(opts.recallMsg) * 1000
  return toTrssSendResult(await e.reply(content, options))
}

/**
 * 包装一个 NG 消息事件
 * @param {object} e NG 消息事件
 * @returns {object} TRSS 形状的事件对象
 */
export function wrapEvent(e) {
  const userId = String(e.sender?.uid ?? '')
  const groupId = e.group?.gid != null ? String(e.group.gid) : null

  return {
    /** 原始 NG 事件，需要 NG 专有能力（prompt、render 等）时用它 */
    ng: e,

    user_id: userId,
    self_id: String(e.selfId ?? ''),
    group_id: groupId,
    isGroup: Boolean(e.isGroup),
    isPrivate: Boolean(e.isPrivate),
    isMaster: Boolean(e.isMaster),
    message_id: String(e.messageId ?? ''),

    // 段数组与纯文本：NG 的 TextSegment 与 TRSS 同形（{ type:'text', text }），
    // 所以 apps/checkin.js 的 rawText() 不用改就能取到未被归一化的原始凭据
    message: e.message,
    raw_message: e.text,
    msg: e.text,

    sender: {
      user_id: userId,
      nickname: e.sender?.name ?? '',
      card: e.sender?.card ?? '',
      role: e.sender?.role ?? (e.isGroupOwner ? 'owner' : (e.isGroupAdmin ? 'admin' : 'member'))
    },

    member: e.isGroup
      ? { is_owner: Boolean(e.isGroupOwner), is_admin: Boolean(e.isGroupAdmin) }
      : undefined,

    group: e.isGroup
      ? { recallMsg: messageId => e.bot.recallMessage(String(messageId)) }
      : undefined,

    reply: (content, quote = false, opts = {}) => replyAsTrss(e, content, quote, opts)
  }
}

/**
 * 造注入给 RelayCheckinCore 的 reply 函数
 * @param {object} e NG 消息事件
 * @returns {Function} TRSS 签名的 reply
 */
export function replyFor(e) {
  return (content, quote = false, opts = {}) => replyAsTrss(e, content, quote, opts)
}
