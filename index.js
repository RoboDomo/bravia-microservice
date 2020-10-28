//process.env.DEBUG = ""; // BraviaHost,HostBase";
process.env.DEBUG = "BraviaHost";
process.title = process.env.TITLE || "bravia-microservice";

const debug = require("debug")("BraviaHost"),
  Bravia = require("bravia"),
  LocalStorage = require("node-localstorage").LocalStorage,
  localStorage = new LocalStorage("/tmp/scratch"),
  HostBase = require("microservice-core/HostBase"),
  console = require("console"),
  chalk = require("chalk");

const request = require("superagent");

const POLL_TIME = 2000;

const TOPIC_ROOT = process.env.TOPIC_ROOT || "bravia",
  MQTT_HOST = process.env.MQTT_HOST,
  BRAVIA_HOSTS = process.env.BRAVIA_HOSTS.split(",");

process.on("unhandledRejection", (reason /*, promise*/) => {
  console.log(chalk.red.bold("[PROCESS] Unhandled Promise Rejection"));
  console.log(chalk.red.bold("- - - - - - - - - - - - - - - - - - -"));
  console.log(reason);
  console.log(chalk.red.bold("- -"));
});

//
class BraviaHost extends HostBase {
  constructor(host) {
    super(MQTT_HOST, TOPIC_ROOT + "/" + host);
    debug("constructor", host);
    this.host = host;
    this.inputs = {};
    this.commandQueue = [];
    this.baseUrl = `http://${host}/sony/`;
    this.bravia = new Bravia(this.host);
    this.postId = 1;
    this.storage_key = "bravia-input-" + this.host;
    const input = localStorage.getItem(this.storage_key);
    debug(this.host, this.storage_key, "initial input", input);
    this.state = { input: input || "OFF" };
    this.request = request.agent();
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
      appsList: list,
    };

    return state;
  }

  async launchApplication(title) {
    title = title.toLowerCase();
    for (const app of this.state.appsList) {
      if (app.title.toLowerCase() === title) {
        await this.bravia.appControl.invoke("setActiveApp", "1.0", {
          uri: app.uri,
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

  async pollVolume() {
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
      o = { method: method, params: params, id: ++this.postId, version: "1.0" };

    const res = await this.request
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
      power: power,
    };
  }

  async pollInput() {
    let ret;
    try {
      ret = await this.post("avContent", "getPlayingContentInfo");
      // ret = await this.bravia.avContent.invoke("getPlayingContentInfo");
      if (ret.error) {
        // console.log(this.host, "ret", ret);
      } else {
        // console.log(this.host, ret.result[0].title);
        const input = ret.result[0].title.replace(/\/.*$/, "");
        this.state = {
          input: input,
        };
        localStorage.setItem(this.storage_key, input);
      }
    } catch (e) {
      console.log(this.host, "exception", ret, e);
    }
  }

  async poll() {
    let lastVolume = null;

    debug(this.host, "poll");
    while (1) {
      try {
        await this.getCodes();
        // debug(this.host, "got codes");
        this.state = {
          codes: this.codes,
        };
      } catch (e) {
        debug(this.host, "getCodes exception", e);
      }

      await this.pollPower();
      try {
        const newVolume = await this.pollVolume(),
          encoded = JSON.stringify(newVolume);

        if (lastVolume !== encoded) {
          this.state = {
            volume: await this.pollVolume(),
          };
          lastVolume = encoded;
        }
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.host, "poll pollVolume exception", e);
        }
      }

      try {
        if (!this.state.power) {
          this.state = {
            input: "OFF",
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
            debug(this.host, "bravia send",  cmd);
            this.bravia.send(cmd);
          }
        } else {
          clearInterval(timer);
          timer = null;
        }
      }
    }, 500);
  }

  async command(topic, command) {
    debug("command", command);
    if (command.startsWith("LAUNCH-")) {
      await this.launchApplication(command.substr(7));
    }
    command = command.toUpperCase();
    if (command === "POWERON") {
      this.commandQueue.push("WakeUp");
      this.commandRunner();
      return;
    }
    const cmd = this.codesMap[command.toUpperCase()];
    if (cmd) {
      switch (cmd.toUpperCase().replace(" ", "")) {
        case "HDMI1":
          this.state = { input: "HDMI 1" };
          localStorage.setItem(this.storage_key, "HDMI 1");
          const input = localStorage.getItem(this.storage_key);
          console.log(this.device.input);
          break;
        case "HDMI2":
          this.state = { input: "HDMI 2" };
          localStorage.setItem(this.storage_key, "HDMI 2");
          break;
        case "HDMI3":
          this.state = { input: "HDMI 3" };
          localStorage.setItem(this.storage_key, "HDMI 3");
          break;
        case "HDMI4":
          this.state = { input: "HDMI 4" };
          localStorage.setItem(this.storage_key, "HDMI 4");
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

//
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
  BRAVIA_HOSTS.forEach((host) => {
    tvs[host] = new BraviaHost(host);
  });
}

main();
