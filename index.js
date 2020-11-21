//process.env.DEBUG = ""; // BraviaHost,HostBase";
process.env.DEBUG = "BraviaHost,HostBase";
process.title = process.env.TITLE || "bravia-microservice";

const debug = require("debug")("BraviaHost"),
  Bravia = require("bravia"),
  HostBase = require("microservice-core/HostBase"),
  console = require("console"),
  chalk = require("chalk");

const request = require("superagent");

const POLL_TIME = 500;

const TOPIC_ROOT = process.env.TOPIC_ROOT || "bravia",
  MQTT_HOST = process.env.MQTT_HOST,
  BRAVIA_HOSTS = process.env.BRAVIA_HOSTS.split(",");

process.on("unhandledRejection", (reason /*, promise*/) => {
  console.log(chalk.red.bold("[PROCESS] Unhandled Promise Rejection"));
  console.log(chalk.red.bold("- - - - - - - - - - - - - - - - - - -"));
  console.log(reason);
  console.log(chalk.red.bold("- -"));
});

class BraviaHost extends HostBase {
  constructor(host) {
    super(MQTT_HOST, TOPIC_ROOT + "/" + host);
    debug("constructor", host);
    this.host = host;
    this.inputs = {};
    this.commandQueue = [];
    this.baseUrl = `http://${host}/sony/`;
    this.bravia = new Bravia(this.host);
    this.poll();
  }

  async getApplicationList() {
    const list = await this.bravia.appControl.invoke("getApplicationList"),
      state = {};

    for (let app of list) {
      state[app.title] = app;
    }
    this.state = {
      appsMap: state,
      appsList: list
    };

    return state;
  }

  async launchApplication(title) {
    title = title.toLowerCase();
    for (const app of this.state.appsList) {
      if (app.title.toLowerCase() === title) {
        await this.bravia.appControl.invoke("setActiveApp", "1.0", {
          uri: app.uri
        });
        return;
      }
    }
  }

  async getCodes() {
    if (!this.codes) {
      this.codesMap = {};
      try {
        this.codes = await this.bravia.getIRCCCodes();
        for (const code of this.codes) {
          this.codesMap[code.name.toUpperCase()] = code.name;
          // aliases
          this.codesMap["POWERON"] = "WakeUp";
        }
        //        this.codes.forEach(code => {
        //          debug(this.host, code);
        //        });
      } catch (e) {
        //        if (this.state && this.state.power) {
        debug(this.host, "getCodes exception1", e);
        this.state = { power: false, input: "OFF" };
        //        }
      }
    }

    if (!this.apps) {
      try {
        this.apps = await this.getApplicationList();
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.host, "getCodes exception2", e);
        }
      }
    }
  }

  async getVolume() {
    const volume = await this.bravia.audio.invoke("getVolumeInformation"),
      state = {};

    try {
      for (let vol of volume) {
        state[vol.target] = vol;
      }
    } catch (e) {
      if (this.state && this.state.power) {
        debug(this.host, "getVolume exception", e);
      }
    }
    return state;
  }

  async post(service, method, params) {
    params = params || [];
    const url = this.baseUrl + service,
      o = {
        method: method,
        params: params,
        id: 1,
        version: method.indexOf("SoundSettings") === -1 ? "1.0" : "1.1"
      };

    const res = await request
      .post(url)
      .set("ContentType", "application/json; charset=UFT-8")
      .set("X-Auth-PSK", "0000")
      .send(o);

    return JSON.parse(res.text);
  }

  async pollPower() {
    const ret = await this.post("system", "getPowerStatus"),
      power = ret.result[0].status === "active";
    this.state = {
      power: power
    };
  }

  async pollInput() {
    const ret = await this.post("avContent", "getPlayingContentInfo");
    if (ret.error) {
      this.state = { input: "HDMI 1" };
    } else {
      this.state = {
        input: ret.result[0].title.replace(/\/.*$/, "")
      };
    }
  }

  async getPlayingContentInfo() {
    try {
      var state = await this.bravia.avContent.invoke("getPlayingContentInfo");
      return state;
    } catch (e) {
      debug(this.host, "getPlayingContentInfo  exception", e);
      return false;
    }
  }

  async pollSpeakers() {
    try {
      const ret = await this.bravia.audio.invoke("getSoundSettings", "1.1", {}),
        result = ret[0];

      if (!result.currentValue) {
        return;
      }
      this.state = { speakers: result.currentValue };
    } catch (e) {
      debug(this.host, "pollSpeakers  exception", e);
    }
  }

  async poll() {
    let lastVolume = null;

    while (1) {
      try {
        await this.pollSpeakers();
      } catch (e) {
        debug(this.host, "pollSpeakers exception", e);
      }
      try {
        await this.getCodes();
        this.state = {
          codes: this.codes
        };
      } catch (e) {
        debug(this.host, "getCodes exception", e);
      }

      await this.pollPower();

      try {
        const newVolume = await this.getVolume(),
          encoded = JSON.stringify(newVolume);

        if (lastVolume !== encoded) {
          this.state = {
            volume: newVolume // await this.getVolume()
          };
          lastVolume = encoded;
        }
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.host, "poll getVolume exception", e);
        }
      }

      try {
        if (!this.state.power) {
          this.state = {
            input: "Off"
          };
        } else {
          await this.pollInput();
        }
      } catch (e) {
        debug(this.host, "poll exception", e);
      }

      await this.wait(POLL_TIME);
    }
  }

  async commandRunner() {
    let timer = setInterval(() => {
      if (this.codesMap.POWERON) {
        const command = this.commandQueue.shift();
        if (command) {
          const cmd = this.codesMap[command.toUpperCase()];
          if (cmd) {
            console.log("bravia send", this.host, cmd);
            this.bravia.send(cmd);
          }
        } else {
          clearInterval(timer);
          timer = null;
        }
      }
    }, 500);
  }

  /**
   * command - handle commands from MQTT
   */
  async command(topic, command) {
    console.log("command", command);
    if (command.startsWith("LAUNCH-")) {
      await this.launchApplication(command.substr(7));
      return;
    }

    if (command === "SPEAKERS") {
      try {
        await this.post("audio", "setSoundSettings", [
          {
            settings: [
              {
                value: "speaker",
                target: "outputTerminal"
              }
            ]
          }
        ]);
      } catch (e) {
        console.log("e", e);
      }
      return;
    } else if (command === "AUDIOSYSTEM") {
      try {
        await this.post("audio", "setSoundSettings", [
          {
            settings: [
              {
                value: "audioSystem",
                target: "outputTerminal"
              }
            ]
          }
        ]);
      } catch (e) {
        console.log("e", e);
      }
      return;
    }

    command = command.toUpperCase();
    if (command === "POWERON") {
      this.commandQueue.push("WakeUp");
      this.commandRunner();
      //      this.bravia.send("WakeUp");
      return;
    }

    const cmd = this.codesMap[command.toUpperCase()];
    if (cmd) {
      switch (cmd.toUpperCase().replace(" ", "")) {
        case "HDMI1":
          this.state = { input: "HDMI 1" };
          break;
        case "HDMI2":
          this.state = { input: "HDMI 1" };
          break;
        case "HDMI3":
          this.state = { input: "HDMI 3" };
          break;
        case "HDMI4":
          this.state = { input: "HDMI 3" };
          break;
      }
      this.commandQueue.push(cmd);
      if (this.commandQueue.length < 2) {
        this.commandRunner();
      }

    } else {
      console.log(this.host, "invalid command", command);
    }
  }
}

const tvs = {};

function main() {
  if (!MQTT_HOST) {
    console.log("ENV variable MQTT_HOST not found");
    process.exit(1);
  }
  if (!BRAVIA_HOSTS || !BRAVIA_HOSTS.length) {
    console.log("ENV variable BRAVIA_HOSTS not found");
    process.exit(1);
  }
  BRAVIA_HOSTS.forEach(host => {
    tvs[host] = new BraviaHost(host);
  });
}

main();
