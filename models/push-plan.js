/**
 * 按机器人和固定目标群生成推送计划。
 * 同一机器人名下的全部用户会合并到每一个目标群。
 */
export function buildGroupPushPlan(done, targetGroups) {
  const groups = new Map()
  for (const item of done) {
    for (const groupId of targetGroups) {
      const gk = `${item.entry.selfId}:${groupId}`
      if (!groups.has(gk)) {
        groups.set(gk, { selfId: item.entry.selfId, groupId, items: [] })
      }
      groups.get(gk).items.push(item)
    }
  }
  return [...groups.values()]
}
