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

var tap = require('tap');
var test = tap.test;

var couch = require('./couch');
var follow = require('../api');

couch.setup(test);

test('Supports valid `/_changes` feed parameters', function(t) {
  var feed = new follow.Feed();
  feed.db = couch.DB;

  var params = {};
  params.conflicts = false;
  params.descending = false;
  params.feed = 'continuous';
  params.heartbeat = 12345;
  params.include_docs = false;
  params.limit = 12345;
  params.seq_interval = 1;
  params.since = 0;
  params.style = 'main_only';
  params.timeout = 12345;

  // add parameters
  Object.keys(params).forEach(function(param) {
    feed[param] = params[param];
  });

  feed.on('query', function(req) {
    var query = [];
    Object.keys(params).forEach(function(param) {
      query.push(`${param}=${params[param]}`);
    });

    t.equal(req.uri.query, query.join('&'));
    t.end();
  });

  feed.on('change', function() {
    this.stop();
  });

  feed.follow();
});

test('Ignore invalid `/_changes` feed parameters', function(t) {
  var feed = new follow.Feed();
  feed.db = couch.DB;

  feed.foo = 'bar'; // invalid feed parameter

  feed.on('query', function(req) {
    t.equal(req.uri.query, 'feed=continuous&heartbeat=30000&seq_interval=1&since=0');
    t.end();
  });

  feed.on('change', function() {
    this.stop();
  });

  feed.follow();
});
