// Copyright © 2017 IBM Corp. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict';

const http = require('http');
const querystring = require('querystring');
const url = require('url');

const server = http.createServer();

// configuration

const defaults = {
  abortEvery: 179,
  heartbeat: 6000, // ms
  lastSeqEvery: 307,
  maxDelay: 20000, // ms
  minDelay: 5000, // ms
  port: 3000,
  probOfDelay: 0.3, // [0, 1]
  probOf500: 0.2, // [0, 1]
  timeout: 60000, // ms
  totalUpdates: 123456789
};

// CLI parser

var program = require('commander');
program
  .description('Mock `/_changes` and `/_db_updates` server.')
  .usage('[options...]')
  .option('-a, --abort-every <n>',
    `Abort request every N sequences (default: ${defaults.abortEvery})`,
    Number, defaults.abortEvery)
  .option('-d, --delay-probability <n>',
    `Probability of a delay occurring (default: ${defaults.probOfDelay})`,
    Number, defaults.probOfDelay)
  .option('-e, --error-probability <n>',
    `Probability of a 500 error response occurring (default: ${defaults.probOf500})`,
    Number, defaults.probOf500)
  .option('-h, --heartbeat <n>',
    `Default heartbeat parameter (default: ${defaults.heartbeat})`,
    Number, defaults.heartbeat)
  .option('-l, --last-seq-every <n>',
    `Send last_seq every N sequences (default: ${defaults.lastSeqEvery})`,
    Number, defaults.lastSeqEvery)
  .option('-m, --min-delay <n>',
    `Minimum delay between updates (default: ${defaults.minDelay})`,
    Number, defaults.minDelay)
  .option('-n, --max-delay <n>',
    `Maximum delay between updates (default: ${defaults.maxDelay})`,
    Number, defaults.maxDelay)
  .option('-p, --port <n>',
    `Port to listen on (default: ${defaults.port})`,
    Number, defaults.port)
  .option('-t, --timeout <n>',
    `Maximum period to wait for a change before the response is sent (default: ${defaults.timeout})`,
    Number, defaults.timeout)
  .option('-u, --total-updates <n>',
    `Total number of updates available in the feed (default: ${defaults.totalUpdates})`,
    Number, defaults.totalUpdates)
  .parse(process.argv);

const cfg = {
  abortEvery: program.abortEvery,
  heartbeat: program.heartbeat,
  lastSeqEvery: program.lastSeqEvery,
  maxDelay: program.maxDelay,
  minDelay: program.minDelay,
  port: program.port,
  probOfDelay: program.delayProbability,
  probOf500: program.errorProbability,
  totalUpdates: program.totalUpdates,
  timeout: program.timeout,
  // options not configurable via the CLI
  feed: 'normal',
  limit: -1, // infinite
  seq_interval: 1,
  since: 0
};

console.log('Mock server configuration:');
console.log(JSON.stringify(cfg, null, 4));

// utils

function getRandomArbitrary(min, max) {
  return Math.random() * (max - min) + min;
}

function createSleepPromise(timeout) {
  return new Promise(function(resolve) {
    setTimeout(resolve, timeout);
  });
}

function sleep(timeout) {
  function promiseFunction(value) {
    return createSleepPromise(timeout).then(function() {
      return value;
    });
  }
  promiseFunction.then = function() {
    var sleepPromise = createSleepPromise(timeout);
    return sleepPromise.then.apply(sleepPromise, arguments);
  };
  promiseFunction.catch = Promise.resolve().catch;
  return promiseFunction;
}

// response

class Response {
  constructor(request, response) {
    this._cfg = Object.assign({}, cfg);

    this.response = response;
    this.request = request;
    this.requestType = 'other';

    this._parseQuery();
  }

  _parseQuery() {
    var parsed = url.parse(this.request.url);
    var query = parsed.query ? querystring.parse(parsed.query) : {};

    console.log(`Received request: ${url.format(parsed)}`);

    var pathname = parsed.pathname;
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1); // remove trailing slash
    }

    if (pathname.endsWith('_changes')) {
      this.requestType = 'changes';
    } else if (pathname.endsWith('_db_updates')) {
      this.requestType = 'db_updates';
    }

    // parse query arguments
    if (query.feed) {
      this._cfg.feed = query.feed;
    }
    if (query.heartbeat) {
      this._cfg.heartbeat = parseInt(query.heartbeat, 10);
    }
    if (query.limit) {
      this._cfg.limit = parseInt(query.limit, 10);
    }
    if (query.seq_interval) {
      this._cfg.seq_interval = parseInt(query.seq_interval, 10);
    }
    if (query.seq_interval) {
      this._cfg.seq_interval = parseInt(query.seq_interval, 10);
    }
    if (query.since) {
      this._cfg.since = parseInt(query.since.split('-')[0], 10);
    }
    if (query.timeout) {
      this._cfg.timeout = parseInt(query.timeout, 10);
    }
  }

  send() {
    var self = this;

    // set CT header
    self.response.setHeader('Content-Type', ['application/json', 'charset=UTF-8']);

    if (self.requestType === 'other') {
      // return 200 OK
      self.response.writeHead(200);
      self.response.end('{"db_name":"foobar","instance_start_time":123,"couchdb":"Welcome"}\n');
      return;
    }

    // set TE header
    self.response.setHeader('Transfer-Encoding', 'chunked');

    if (Math.random() <= self._cfg.probOf500) {
      // send 500
      console.log('Returning 500!');
      self.response.writeHead(500);
      self.response.end('{"error":"internal_server_error"}\n');
      return;
    }

    if ([ 'continuous', 'eventsource', 'live', 'longpoll', 'normal' ].indexOf(self._cfg.feed) === -1) {
      // send 400
      console.log('Returning 400!');
      self.response.writeHead(400);
      self.response.end('{"error":"bad_request","reason":"Supported `feed` types: normal, continuous, live, longpoll, eventsource"}\n');
      return;
    }

    // send 200
    var p = sleep(0); // no delay for first update

    var stop = false;

    if (self._cfg.feed === 'longpoll') {
      self._cfg.feed = 'normal';

      // maybe send heartbeat(s)
      let sleepMs = getRandomArbitrary(self._cfg.minDelay, self._cfg.maxDelay);

      if (sleepMs >= self._cfg.timeout) {
        console.log(`Timeout exceeded. Sending last_seq!`);
        stop = true;
      }

      while (sleepMs >= self._cfg.heartbeat) {
        self._cfg.limit = 1;
        sleepMs -= self._cfg.heartbeat;
        p = p.then(sleep(self._cfg.heartbeat)).then(
          () => { self.response.write('\n'); } // send heartbeat
        );
      }
    }

    if (self._cfg.feed === 'normal') {
      p.then(() => { self.response.write('{"results":[\n'); });
    }

    var i = 0;
    var updateCount = self._cfg.since; // start seq

    var abort = false;

    while (!stop) {
      if (self._cfg.limit === 0 || updateCount >= self._cfg.totalUpdates) {
        console.log(`Reached seq limit '${updateCount}'. Stopping feed and sending last_seq!`);
        stop = true;
        break;
      }

      i++;
      updateCount++;

      if (self._cfg.limit > 0 && i >= self._cfg.limit) {
        console.log(`Reached update limit of '${self._cfg.limit}'. Sending last_seq!`);
        stop = true;
      } else if (updateCount % self._cfg.abortEvery === 0) {
        console.log(`Aborting response on seq '${updateCount}'!`);
        abort = true;
        stop = true;
      } else if (updateCount % self._cfg.lastSeqEvery === 0) {
        console.log(`Faking maintenance mode on seq '${updateCount}'. Sending last_seq!`);
        stop = true;
      }

      let seq = null;
      if (i === 1 || self.requestType === 'db_updates' || i % self._cfg.seq_interval === 0) {
        seq = `"${updateCount}-xxxxxxxx"`;
      }

      let update;
      if (self.requestType === 'changes') {
        // `/_changes`
        update = `{"seq":${seq},"id":"doc${updateCount}","changes":[{"rev":"1-xxxxxxxx"}]}`;
      } else if (self.requestType === 'db_updates') {
        // `/_db_updates`
        update = `{"db_name":"db${updateCount}","type":"created","seq":${seq}}`;
      } else {
        throw new Error(`Unknown request type: ${self.requestType}`);
      }

      // write update
      if (self._cfg.feed === 'normal' && !stop) {
        p = p.then(() => { self.response.write(update + ',\n'); });
      } else {
        p = p.then(() => { self.response.write(update + '\n'); });
      }

      if (['longpoll', 'normal'].indexOf(self._cfg.feed) === -1 && Math.random() <= self._cfg.probOfDelay) {
        // maybe send heartbeat
        let sleepMs = getRandomArbitrary(self._cfg.minDelay, self._cfg.maxDelay);

        if (sleepMs >= self._cfg.timeout) {
          console.log(`Timeout exceeded. Sending last_seq!`);
          stop = true;
        }

        while (sleepMs >= self._cfg.heartbeat) {
          sleepMs -= self._cfg.heartbeat;
          p = p.then(sleep(self._cfg.heartbeat)).then(
            () => { self.response.write('\n'); } // send heartbeat
          );
        }
        p = p.then(sleep(sleepMs)); // sleep
      }
    }

    if (!abort) {
      p = p.then(() => {
        // send last_seq
        var pending = self._cfg.totalUpdates - updateCount;
        if (pending < 0) {
          pending = 0;
        }

        var last_seq = updateCount;
        if (last_seq > self._cfg.totalUpdates) {
          last_seq = self._cfg.totalUpdates;
        }

        if (self._cfg.feed === 'normal') {
          self.response.write(`],\n"last_seq":"${last_seq}-xxxxxxxx","pending":${pending}}\n`);
        } else {
          self.response.write(`{"last_seq":"${last_seq}-xxxxxxxx","pending":${pending}}\n`);
        }
      });
    }

    p.then(() => { self.response.end(); });
  }
}

// server

server
  .on('request', (request, response) => {
    (new Response(request, response)).send();
  });

server.listen(cfg.port, 'localhost', () => {
  console.log(`Listening on port ${cfg.port}...`);
});
