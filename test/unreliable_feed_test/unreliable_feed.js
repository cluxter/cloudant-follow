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

const debug = require('debug')('cloudant-follow:test:feed_changes');
const follow = require('../../api');
const spawn = require('child_process').spawn;
const tap = require('tap');

// mock server options:
const port = 3000;
const totalUpdates = 500;

var mockServer;

tap.beforeEach(function(done) {
  mockServer = spawn('node', [
    './test/unreliable_feed_test/mocks/mock_server.js',
    // CLI arguments:
    '--abort-every', 59,
    '--delay-probability', 0.1,
    '--error-probability', 0.3,
    '--heartbeat', 6000,
    '--last-seq-every', 181,
    '--min-delay', 100,
    '--max-delay', 5000,
    '--port', port,
    '--total-updates', totalUpdates
  ]);
  // capture stdout/stderr
  mockServer.stderr.on('data', (data) => {
    debug(data.toString());
  });
  mockServer.stdout.on('data', (data) => {
    debug(data.toString());
    if (data.toString().startsWith('Listening on port')) {
      done();
    }
  });
});

tap.afterEach(function(done) {
  mockServer.kill();
  done();
});

tap.test('Captures all changes in unreliable `/_changes` feed', { timeout: 300000 }, function(t) {
  var actualChanges = [];
  var expectedChanges = [];

  // build expected changes array
  for (let i = 1; i <= totalUpdates; i++) {
    expectedChanges.push(`doc${i}`);
  }

  var feed = new follow.Feed();
  feed.db = `http://localhost:${port}/foo`;

  feed
    .on('error', function(error) {
      t.fail(`Unexpected error: ${error}`);
    })
    .on('change', function(change) {
      let i = actualChanges.indexOf(change.id);
      t.equal(i, -1, `Unseen change for doc '${change.id}'.`);
      t.ok(change.seq, 'Valid seq for change.');

      actualChanges.push(change.id);
      if (actualChanges.length === totalUpdates) {
        feed.stop();
      }
    })
    .on('stop', function() {
      t.deepEqual(actualChanges, expectedChanges);
      t.end();
    });

  feed.follow();
});

tap.test('Captures all changes in unreliable `/_db_updates` feed', { timeout: 300000 }, function(t) {
  var actualUpdates = [];
  var expectedUpdates = [];

  // build expected updates array
  for (let i = 1; i <= totalUpdates; i++) {
    expectedUpdates.push(`db${i}`);
  }

  var feed = new follow.Feed();
  feed.db = `http://localhost:${port}/_db_updates`;

  feed
    .on('error', function(error) {
      t.fail(`Unexpected error: ${error}`);
    })
    .on('change', function(change) {
      let i = actualUpdates.indexOf(change.db_name);
      t.equal(i, -1, `Unseen update for db '${change.db_name}'.`);
      t.equal(change.type, 'created', 'Found expected change type "created".');

      actualUpdates.push(change.db_name);
      if (actualUpdates.length === totalUpdates) {
        feed.stop();
      }
    })
    .on('stop', function() {
      t.deepEqual(actualUpdates, expectedUpdates);
      t.end();
    });

  feed.follow();
});
