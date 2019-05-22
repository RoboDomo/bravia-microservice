//process.env.DEBUG = ""; // BraviaHost,HostBase";
process.env.DEBUG = "BraviaHost,HostBase";

const debug = require("debug")("BraviaHost"),
  Bravia = require("bravia"),
  HostBase = require("microservice-core/HostBase"),
  console = require("console"),
  chalk = require("chalk");

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
      try {
        this.codes = await this.bravia.getIRCCCodes();
        //        this.codes.forEach(code => {
        //          debug(this.device, code);
        //        });
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.device, "getCodes exception1", e);
        }
      }
    }
    if (!this.apps) {
      try {
        this.apps = await this.getApplicationList();
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.device, "getCodes exception2", e);
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
        debug(this.device, "getVolume exception", e);
      }
    }
    return state;
  }

  async getPowerStatus() {
    try {
      var state = await this.bravia.system.invoke("getPowerStatus");
      return state;
    } catch (e) {
      debug(this.device, "getPowerStatus exception", e);
      return false;
    }
  }

  async getInputStatus() {
    try {
      var state = await this.bravia.avContent.invoke(
        "getCurrentExternalInputsStatus"
      );
      return state;
    } catch (e) {
      debug(this.device, "getInputStatus  exception", e);
      return false;
    }
  }

  async getPlayingContentInfo() {
    //    console.log("getPlayingContentInfo");
    try {
      var state = await this.bravia.avContent.invoke("getPlayingContentInfo");
      console.log("GOT STATE");
      console.log("state", state);
      return state;
    } catch (e) {
      debug(this.device, "getPlayingContentInfo  exception", e);
      return false;
    }
  }

  async poll() {
    let lastVolume = null;

    debug(this.device, "poll");
    while (1) {
      try {
        await this.getCodes();
        //        console.log("---");
        //        for (const code of this.codes) {
        //          console.log("code: ", code.name);
        //        }
        //        console.log("---");
        this.state = {
          codes: this.codes
        };
      } catch (e) {
        debug(this.device, "getCodes exception", e);
      }

      try {
        const state = await this.getPowerStatus();
        this.state = {
          power: state.status === "active"
        };
      } catch (e) {
        debug(this.device, "poll exception", e);
      }

      try {
        const newVolume = await this.getVolume(),
          encoded = JSON.stringify(newVolume);

        if (lastVolume !== encoded) {
          this.state = {
            volume: await this.getVolume()
          };
          lastVolume = encoded;
        }
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.device, "poll getVolume exception", e);
        }
      }

      try {
        const inputs = await this.getInputStatus();
        this.inputs = Object.assign(this.inputs, inputs);
        this.state = {
          inputs: this.inputs
        };
      } catch (e) {
        debug(this.device, "poll exception", e);
      }

      try {
        if (!this.state.power) {
          this.state = {
            input: "Off"
          };
        } else {
          const nowPlaying = await this.getPlayingContentInfo();
          let input = nowPlaying.title.toLowerCase().replace(/\s+/g, "");

          if (input.indexOf("hdmi") === 0) {
            input = input.substr(0, 5);
          }
          //        console.log("input", input, nowPlaying.title);
          this.state = {
            input: input
          };
        }
      } catch (e) {
        debug(this.device, "poll exception", e);
      }

      await this.wait(POLL_TIME);
    }
  }

  async command(topic, command) {
    debug("command", command);
    if (command.startsWith("LAUNCH-")) {
      await this.launchApplication(command.substr(7));
      //      await this.bravia.appControl.invoke("setActiveApp", "1.0", {
      //        uri: command.substr(7)
      //      });
      //      debug(
      //        this.device,
      //        "getPlayingContentInfo",
      //        await this.bravia.avContent.invoke("getPlayingContentInfo", "1.0")
      //      );
      //      Promise.resolve();
    }
    return this.bravia.send(command);
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
