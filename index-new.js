//process.env.DEBUG = ""; // BraviaHost,HostBase";
process.env.DEBUG = "BraviaHost,HostBase";
process.title = process.env.TITLE || "bravia-microservice";

const debug = require("debug")("BraviaHost"),
  superagent = require("superagent"),
  net = require("net"),
  HostBase = require("microservice-core/HostBase"),
  console = require("console"),
  chalk = require("chalk");

const POLL_TIME = 500;

const TOPIC_ROOT = process.env.TOPIC_ROOT || "bravia",
  MQTT_HOST = process.env.MQTT_HOST,
  BRAVIA_HOSTS = process.env.BRAVIA_HOSTS.split(",");

const request = require("superagent");

class BraviaHost extends HostBase {
  constructor(host) {
    super(MQTT_HOST, TOPIC_ROOT + "/" + host);
    this.baseUrl = `http://${host}/sony/`;
    debug("BraviaHost", host, this.baseUrl);
    this.host = host;

    this.poll();
  }

  async post(service, method, params) {
    params = params || [];
    const url = this.baseUrl + service;
    const o = {method: method, params: params, id: 1, version: "1.0"};
    console.log("post", service, url, o);
    const res = await request
      .post(url)
      .set("ContentType", "application/json; charset=UFT-8")
      .set("X-Auth-PSK", "0000")
      .send(o);
    return res;
  }

  async poll() {
    console.log("poll");
    try {
//      const ret = await this.post("system", "requestReboot");
      const ret = await this.post("avContent", "getPlayingContentInfo");
      console.log(this.host, "ret", ret.text);
    }
    catch (e) {
      console.log("poll exception", e.stack)
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
