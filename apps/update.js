import { update as Update } from '../../other/update.js'

export class RelayCheckinUpdate extends plugin {
  constructor() {
    super({
      name: 'relay-checkin-plugin更新',
      dsc: '#中转插件更新 #中转插件强制更新',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: /^#?中转(?:站)?插件(强制)?更新$/, fnc: 'update', permission: 'master' }
      ]
    })
  }

  async update(e = this.e) {
    e.isMaster = true
    e.msg = `#${e.msg.includes('强制') ? '强制' : ''}更新relay-checkin-plugin`
    const up = new Update(e)
    up.e = e
    return up.update()
  }
}
