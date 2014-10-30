var cfg        = require('../lib/config');
var connect    = require('../lib/backend');
var keys       = require('ssb-keys')
var level      = require('level')
var sublevel   = require('level-sublevel/bytewise')
var prettydate = require('pretty-date');
var pull       = require('pull-stream');
var toPull     = require('stream-to-pull-stream');
var msgpack    = require('msgpack-js')

function padleft(width, str) {
	if (str.length < width) {
		return '                                        '.slice(0, width - str.length) + str;
	}
	return str;
}

function namefileHelp() {
	console.log('You don\'t have a profile yet. Run \'node phoenix setup\' first.');
}

function introHelp() {
	console.log('')
	console.log('Get started by running \'./phoenix serve\'')
	console.log('For help, use the -h switch')
	console.log('');
}

exports.setup = function(opts) {
	var nicknameRE = /^[A-z][0-9A-z_-]*$/;
	var nickname;
	var rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });

	// key overwriting
	var keypair = keys.loadSync(cfg.namefile)
  if(keypair && !opts['force-new-keypair']) {
    console.error('Keyfile already exists.')
    console.log('')
    console.log('Use --force-new-keypair to destroy the old keyfile and create a new one.')
    console.log('(Warning: this will destroy your account!)')
    console.log('')
    rl.close()
    return
  }

	var opts = require('secure-scuttlebutt/defaults')
	var ssb = require('secure-scuttlebutt')(sublevel(level(cfg.dbpath, { valueEncoding: opts.codec }, handleDbOpen)), opts)
	function handleDbOpen(err) {
		if (err) {
			if (err.type == 'OpenError')
				console.error('Can not open the database because it is already open. If the phoenix server is running, please stop it first.')
			else if (err.type == 'InitializationError')
				console.error('Can not open the database because no path was found in the config. Please check that .phoenixrc contains a valid `datadir` setting.')
			else
				console.error(err.toString())
			rl.close()
			return
		}
		// setup profile
		rl.question('Nickname? > ', handleNickname);
	}
	function handleNickname(input) {
		if (!nicknameRE.test(input)) {
			console.log('Letters, numbers, dashes and underscores only. Must start with a letter.');
			return rl.close();
		}
		nickname = input;
		console.log('\nNickname is \'' + nickname + '\'');
		rl.question('Is this correct? [y/N]> ', handlePublish);
	}
	function handlePublish(input) {
		console.log('');
		rl.close();
		if (input.toLowerCase() != 'y')
			return console.log('Aborted.');

		// setup keys
		keys.create(cfg.namefile, function(err, keypair) {
			if (err) {
				console.error('Error creating keys:')
				console.error(err.toString())
				return
			}
			
			// publish profile
			var feed = ssb.createFeed(keypair)
			feed.add({ type: 'profile', nickname: nickname }, function(err) {
				if (err) return console.error('Failed to publish profile', err);
				console.log('Ok.');
				introHelp();
			})
		})
	}
}

exports.list = function(opts) {
	connect(function(err, backend) {
		if (err) return console.error(err);

		var profiles = {};
		function fetchProfile(msg, cb) {
			var id = msg.author.toString('hex');
			if (profiles[id]) {
				msg.nickname = profiles[id].nickname;
				return cb(null, msg);
			}
			backend.profile_getProfile(msg.author, function(err, profile) {
				if (err && !err.notFound) return console.error(err), cb(err);
				msg.nickname = (profile) ? profile.nickname : '???';
				profiles[id] = profile;
				cb(null, msg);
			});
		}

		var hadMessages = false;
		function toDetailed (msg) {
			hadMessages = true;
			var author = msg.author.toString('hex');
			console.log (
				//proquint.encodeCamelDash(msg.author).substring(0, 43) + ' / ' +
				author.slice(0, 12) + '...' + author.slice(-4) + ' / ' +
				msg.sequence + '\n' +
				msg.type.toString('utf8') + ' : '+
				new Date(msg.timestamp).toISOString() + '\n' +
				( msg.type.toString('utf8') == 'init'
				? msg.message.toString('hex') + '\n'
				: msg.message.toString('utf8') + '\n' )
			);
		}
		function toSimple(msg) {
			if (!hadMessages) console.log('user   seq   time             nickname     message');
			hadMessages = true;
			var content = ''
			switch (msg.type.toString()) {
				case 'init': content = 'Account created: ' + msg.message.toString('hex').slice(0,16) + '...'; break
				case 'profile': content = 'Now known as ' + msgpack.decode(msg.message).nickname; break
				case 'text': content = msgpack.decode(msg.message).plain; break
				default: content = msg.message.toString()
			}
			var author = msg.author.toString('hex');
			var output =
				author.slice(0, 4) + ' | ' +
				padleft(3, ' '+msg.sequence) + ' | ' +
				padleft(14, prettydate.format(new Date(msg.timestamp))) + ' | ' +
				padleft(10, msg.nickname) + ' | ' +
				content
			;
			console.log(output);
		}

		backend.getKeys(function(err, keys) {
			if (keys.exist) {
				pull(
					toPull(backend.createFeedStream({ tail: opts.tail })),
					pull.asyncMap(fetchProfile),
					pull.drain((opts.long) ? toDetailed : toSimple, function() {
						if (!hadMessages) {
							console.log('No messages in your feed.');
							introHelp();
						}
						backend.close();
					})
				);
			} else {
				console.log('This appears to be your first time using Phoenix (no keyfile found). Running setup.')
				backend.close();
				exports.setup(opts);
			}
		})
	});
}

exports.post = function(opts) {
	connect(function(err, backend) {
		if (err) return console.error(err);

		backend.getKeys(function(err, keys) {
			if (err) return console.error(err), backend.close();
			if (!keys.exist) return namefileHelp(), backend.close();
			backend.text_post(opts.text, function(err) {
				if (err) console.error(err);
				else console.log('Ok.');
				backend.close();
			});
		});
	});
}
