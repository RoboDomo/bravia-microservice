process.env.DEBUG='BraviaHost,HostBase'

const debug    = require('debug')('BraviaHost'),
      Bravia   = require('bravia'),
      HostBase = require('microservice-core/HostBase')

const POLL_TIME = 500

const TOPIC_ROOT  = process.env.TOPIC_ROOT || 'bravia',
      MQTT_HOST   = process.env.MQTT_HOST,
      BRAVIA_HOSTS = process.env.BRAVIA_HOSTS.split(',')

class BraviaHost extends HostBase {
    constructor(host) {
        super(MQTT_HOST, TOPIC_ROOT + '/' + host)
        debug('constructor', host)
        this.host = host
        this.bravia = new Bravia(this.host)
        this.poll()
    }

    async getApplicationList() {
        const list  = await this.bravia.appControl.invoke('getApplicationList'),
              state = {}

        for (let app of list) {
            state[app.title] = app
        }
        this.state = {
            appsMap: state,
            appsList: list
        }

        return state
    }

    async getCodes() {
        if (!this.codes) {
            try {
                this.codes = await this.bravia.getIRCCCodes()
                this.codes.forEach((code) => {
                    debug(this.device, code)
                })
            }
            catch (e) {
            }
        }
        if (!this.apps) {
            try {
                this.apps = await this.getApplicationList()
            }
            catch (e) {
            }

        }
    }

    async getVolume() {
        const volume = await this.bravia.audio.invoke('getVolumeInformation'),
              state  = {}

        try {
            for (let vol of volume) {
                state[vol.target] = vol
            }
        }
        catch (e) {
            console.dir(e)
        }
        return state
    }

    async getPowerStatus() {
        var state = await this.bravia.system.invoke('getPowerStatus')
        return state
    }


    async poll() {
        let lastVolume = null

        debug(this.device, 'poll')
        while (1) {
            try {
                await this.getCodes()
            }
            catch (e) {
                if (this.state.power === 'on') {
                    debug(this.device, 'getCodes exception', e)
                }
            }
            try {
                const newVolume = await this.getVolume(),
                      encoded = JSON.stringify(newVolume)

                if (lastVolume !== encoded) {
                    this.state = {
                        volume: await this.getVolume()
                    }
                    lastVolume = encoded
                }
            }
            catch (e) {
                if (this.state.power === 'on') {
                    debug(this.device, 'getVolume exception', e)
                }
            }
            try {
                const state = await this.getPowerStatus()
                this.state = {
                    power: state.status === 'active'
                }
            }
            catch (e) {

            }
            await this.wait(POLL_TIME)

        }
    }

    async command(topic, command) {
        debug('command', command)
        if (command.startsWith('LAUNCH-')) {
            await this.bravia.appControl.invoke('setActiveApp', '1.0', { uri: command.substr(7) })
            debug(this.device, 'getPlayingContentInfo', await this.bravia.avContent.invoke('getPlayingContentInfo', '1.0'))
            Promise.resolve()
        }
        return this.bravia.send(command)
    }
}

const tvs = {}

function main() {
    if (!MQTT_HOST) {
        console.log('ENV variable MQTT_HOST not found')
        process.exit(1)
    }
    if (!BRAVIA_HOSTS || !BRAVIA_HOSTS.length) {
        console.log('ENV variable BRAVIA_HOSTS not found')
        process.exit(1)
    }
    BRAVIA_HOSTS.forEach((host) => {
        tvs[host] = new BraviaHost(host)
    })
}

main()
