var events = require('events')
  , redis = require('redis')
  , RedisReplica = require('./redisReplica')
  , RedisConfigFetcher = require('./redisConfigFetcher')
  , RedisWatcher = require('./redisWatcher')
  , util = require('./util');


// This is passed into the RedisReplica, so that the client redis objects are their own:
var client_redis = null;

// Uncomment this to debug the redis protocol stuffs:
// redis.debug_mode = true;


function RedisSentinel(sentinels, options) {
  if (!(this instanceof RedisSentinel)) {
    return new RedisSentinel(sentinels, options);
  }

  // Add in the things that will be asynchronously populated later:
  this.fetcher = null;
  this.watcher = null;
  this.replicas = {};

  // Keep track of death:
  this.terminated = false;

  // Simple validation:
  RedisSentinel._validateSentinelList(sentinels);

  // Extend the default values with the custom parameters:
  var defaults = {
    commandTimeout:     1500,
    createClient:       client_redis && client_redis.createClient || redis.createClient,
    customLogger:       null,
    debugLogging:       false,
    outageRetryTimeout: 5000,
    randomizeSentinels: true,
    redisOptions:       {},
    refreshTimeout:     60000,
    timeout:            500,
    watchedNames:       null,
  };

  this.options = util._.extend(defaults, options);

  // Make sure that the outside can't inject a test client:
  delete this.options._testClient;

  this._log = util.buildLogger("RedisSentinel");
  this._log.configure(this.options);

  this._log("Initialization started. Has client redis:", !!client_redis);

  // Store connection info for all the sentinels:
  this.sentinels = sentinels.map(function (conf) {
    var host = String(conf.host)
      , port = parseInt(conf.port, 10) || 26379;

    return { host: host, port: port };
  });

  this._dedupeSentinels();

  // Start this sucker on its way:
  this._connectSentinel();
}

// Inherit from EventEmitter, so we can emit stuff:
util.inherits(RedisSentinel, events.EventEmitter);


/**
 * Will do basic validation on a sentinel list. Throws if there was a problem.
 *
 * @param  {Array} sentinels The sentinel list, from the user.
 */
RedisSentinel._validateSentinelList = function _validateSentinelList(sentinels) {

  // First, check type:
  if (!sentinels || !Array.isArray(sentinels)) {
    throw new TypeError("First argument needs to be an array of sentinel config objects");
  }

  // Check array length:
  if (!sentinels.length) {
    throw new TypeError("Sentinels array shouldn't be empty");
  }

  // Now go through each item in the list, and make sure that there's the necessary info:
  sentinels.forEach(function (item, idx) {
    if (!item || typeof item !== 'object') {
      throw new TypeError("Item #" + idx + " in sentinels array isn't an object");
    }
    if (!item.host || typeof item.host !== 'string') {
      throw new Error("Item #" + idx + " in sentinels array doesn't have a correct host property");
    }
  });
};


/**
 * Will try to connect to each item in the sentinels array, in order, until it is
 * successful.
 */
RedisSentinel.prototype._connectSentinel = function _connectSentinel() {
  var sentinel = this;

  this._log("Starting sentinel connection...");

  // Make sure we are iterating over the sentinels in a random order:
  if (this.options.randomizeSentinels) {
    util.shuffleArray(this.sentinels);
  }

  // Call this when shit fucks up:
  var _abortAndReconnect = util._.once(sentinel._handleErrorAndReconnect.bind(sentinel));

  // Try them all!
  util.async.forEachSeries(
    this.sentinels,
    function withEachSentinel(conf, next) {

      var fetcher = sentinel.fetcher = new RedisConfigFetcher(conf.host, conf.port, sentinel.options)
        .once('error', _onError)
        .once('connected', _onConnect);

      // Errors at this stage mean that we will move to the next sentinel:
      function _onError() {
        fetcher.removeListener('connected', _onConnect);
        if (sentinel.terminated) { return; }
        next();
      }

      // Else, cool. Re-hook this thing up in a more stable way, and ask it for a config:
      function _onConnect() {
        fetcher.removeListener('error', _onError);
        if (sentinel.terminated) { return; }

        // Hook up the event handlers for the long run:
        fetcher
          .on('error', _abortAndReconnect)
          .on('config', _onGetReplInfo);

        // Now, create a watcher to poke this sucker along:
        sentinel.watcher = new RedisWatcher(conf.host, conf.port, sentinel.options)
          .on('error', _abortAndReconnect)
          .on('event', _passAlongEvent)
          .on('refresh', fetcher.updateConfigs.bind(fetcher));

        function _passAlongEvent(channel, msg) {
          if (sentinel.terminated) { return; }
          sentinel.emit('event', channel, msg);
        }

        function _onGetReplInfo(name, master, slaves) {
          if (sentinel.terminated) { return; }

          // Create a new RedisReplica if we've never seen this name before:
          if (!sentinel.replicas.hasOwnProperty(name)) {
            sentinel.replicas[name] = new RedisReplica(name, sentinel.options.createClient, sentinel.options.redisOptions);
          }

          // Load the master / slave configs into the struct:
          var repl           = sentinel.replicas[name]
            , master_changed = repl._loadMasterConfig(master)
            , slaves_changed = repl._loadSlaveConfigs(slaves)
            , has_changed    = master_changed || slaves_changed;

          sentinel._log("Repl configuration set:", repl.toString());

          // Emit the repl if things are different:
          if (has_changed) {
            sentinel._log("Repl", name, "has changed");
            sentinel.emit('change', name, repl);
          }
        }
      }
    },
    function (err) {
      if (sentinel.terminated) { return; }
      if (err) {
        sentinel.emit("error", err);
        return;
      }

      // We made it through all endpoints. What do??
      if (sentinel.options.outageRetryTimeout < 0) {
        // Stop, and emit error:
        sentinel.emit("error", new Error("Could not connect to a sentinel. *<:'O("));
        return;

      } else {
        // Loop around and try again in a few seconds:
        sentinel._log("All sentinels down. Pausing before retry...");
        setTimeout(sentinel._connectSentinel.bind(sentinel), sentinel.options.outageRetryTimeout);
      }
    }
  );
};


RedisSentinel.prototype._handleErrorAndReconnect = function _handleErrorAndReconnect(err) {
  if (this.terminated) { return; }

  // Log the error:
  this._log("Error encountered:", err);

  // Kill our redis clients:
  if (this.fetcher) { this.fetcher.kill(); }
  if (this.watcher) { this.watcher.kill(); }
  this.fetcher = this.watcher = null;

  // Trigger a re-connect:
  this._connectSentinel();
};


RedisSentinel.prototype._dedupeSentinels = function _dedupeSentinels() {
  // Dedupe the list based on "host(lowercase):port":
  this.sentinels = util._.uniqBy(this.sentinels, function (conf) {
    return conf.host.toLowerCase() + ":" + conf.port;
  });
};


RedisSentinel.prototype.kill = function kill() {
  if (this.terminated) { return; }
  this.terminated = true;

  this._log("Termination triggered from outside");

  // Kill our redis clients:
  if (this.fetcher) { this.fetcher.kill(); }
  if (this.watcher) { this.watcher.kill(); }
  this.fetcher = this.watcher = null;
};


// Exports:
module.exports.RedisSentinel = RedisSentinel;

// Internal API for passing along the client's Redis library:
module.exports.setClientRedis = function setClientRedis(mod) {
  client_redis = mod;
};
