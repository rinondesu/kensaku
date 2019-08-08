const Discord = require('discord.js');
const RequestPromise = require('request-promise');
const tough = require('tough-cookie');
const cheerio = require('cheerio');
const config = require('config');

const adminDiscordTags = config.get('adminDiscordTags');
const REFRESH_INTERVAL = config.get('refreshIntervalMs');

// Special players who will get extra-exposed when they show up
const tftiPlayers = config.get('tftiPlayers');

// Visible players who will get revealed when they show up
const visiblePlayers = [...config.get('visiblePlayers')]; // Using object spread to clone the .get() array so that we can push new players in

//const tftiEmoji = '<:TFTI:483651827984760842>'; // ID from San Jose DDR Players
//const tftiEmoji = '<:TFTI:537689355553079306>'; // ID from BotTester
const tftiEmoji = '<:TFTI:542983258728693780>'; // ID from DDR Machine Stalking

const msMinute = 60*1000;
const msHour = 60*60*1000;
const RECENT_PLAYER_CUTOFF_MINUTES = 90;
function timeDifferential(nowTime, beforeTime) {
  const hr = Math.floor((nowTime - beforeTime) / msHour);
  const min = Math.floor(((nowTime - beforeTime) % msHour) / msMinute);
  const minOnly = Math.floor((nowTime - beforeTime) / msMinute);
  return {
    h: hr,
    m: min,
    minOnly: minOnly,
    str: `${hr}h ${min}m`
  };
}
function timeString(time, timeZone) {
  return time.toLocaleTimeString([], {
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timeZone
  });
}

// Constructor for Players
function Player (args) {
  this.name = args.dancerName;
  this.ddrCode = args.ddrCode;
  this.loc = args.loc;

  this.firstTime = new Date();
  this.lastTime = new Date();

  // TODO: Fix constructing the same function repeatedly for every Player instance
  this.toLocaleString = function () {
    return this.name + ' ' + this.ddrCode;
  };
}

function isDailyMaintenanceTime() {
  const now = new Date();
  const japanHour = (now.getUTCHours() + 9) % 24;
  return japanHour === 5 || japanHour === 6;
}

function isExtendedMaintenanceTime() {
  return false;
}

// Determine which URL to hit
function getUrl() {
  if (isDailyMaintenanceTime()) {
    // For some reason, on US accounts, this URL works during daily maintenance
    return 'https://p.eagate.573.jp/game/ddr/ddra/p/rival/kensaku.html?mode=4';
  } else {
    // This page is faster and more reliable, but goes down during daily maintenance
    return 'https://p.eagate.573.jp/game/ddr/ddra20/p/rival/kensaku.html?mode=4';
  }
}

// Constructor for cabs
function Cab (cookieValue) {
  this.players = [];
  this.newPlayers = [];
  this.cookieValue = cookieValue;
  this.cookie = new tough.Cookie({
    key: "M573SSID",
    value: cookieValue,
    domain: 'p.eagate.573.jp',
    httpOnly: true,
    maxAge: 31536000
  });
  this.cookiejar = RequestPromise.jar();
  this.cookiejar.setCookie(this.cookie, 'https://p.eagate.573.jp');
  this.prunedPlayers = 0;
}
// Constructor for locations
function Location (loc) {
  this.name = loc.name;
  this.id = loc.id;
  this.cabs = loc.cabs;
  this.timeZone = loc.timeZone;
  this.todaysPlayers = [];
}

function getRecentPlayers(shop) {
  const currentTime = new Date();
  const playerStrings = [];
  // TODO: Use a reduce function
  shop.todaysPlayers.forEach(function(player) {
    const timeSinceSeen = timeDifferential(currentTime, player.lastTime);
    if (timeSinceSeen.minOnly <= RECENT_PLAYER_CUTOFF_MINUTES) {
      const firstTimeString = timeString(player.firstTime, player.loc.timeZone);
      if (visiblePlayers.includes(player.ddrCode)) {
        playerStrings.push(`${player.name.padEnd(8)}   ${firstTimeString}   Seen ${timeSinceSeen.str} ago`);
      } else {
        playerStrings.push(`********   ${firstTimeString}   Seen ${timeSinceSeen.str} ago`);
      }
    }
  });
  return playerStrings;
};

function getTodaysPlayers(shop) {
  const currentTime = new Date();
  const playerStrings = [];
  // TODO: Use a reduce function
  shop.todaysPlayers.forEach(function(player) {
    const firstTime = timeString(player.firstTime, player.loc.timeZone);
    const lastTime = timeString(player.lastTime, player.loc.timeZone);
    const timePlayed = timeDifferential(player.lastTime, player.firstTime);
    if (visiblePlayers.includes(player.ddrCode)) {
      playerStrings.push(`${player.name.padEnd(8)}   ${firstTime} - ${lastTime}   (${timePlayed.str})`);
    } else {
      playerStrings.push(`********   ${firstTime} - ${lastTime}   (${timePlayed.str})`)
    }
  });
  return playerStrings;
}

function tftiCheck(incomingPlayer, locationId) {
  if (tftiPlayers.includes(incomingPlayer.ddrCode)) {
    getChannelsWithName('tfti').map((tftiChannel) => {
      const locationIdChannel = tftiChannel.guild.channels.find(c => c.name === locationId);
      const locationIdString = locationIdChannel ? locationIdChannel.toString() : '#' + locationId;

      const tftiEmojiForThisGuild = tftiChannel.guild.emojis.find((emoji) => emoji.name === 'TFTI');
      const tftiMessage = `${incomingPlayer.name} (${incomingPlayer.ddrCode}) was spotted at ${locationIdString}! ${tftiEmojiForThisGuild}`;

      console.info(`Sending message to ${tftiChannel.guild.name}/#tfti: ${tftiMessage}`);
      tftiChannel.send(tftiMessage).then((message) => {
        message.react(tftiEmojiForThisGuild);
      });
    });
  }
}

function reportNewPlayer(loc, incomingPlayer) {
  if (visiblePlayers.includes(incomingPlayer.ddrCode)) {
    pingChannelsForLocation(loc, monospace(`+ ${incomingPlayer.name}     ${incomingPlayer.ddrCode}`));
  } else {
    pingChannelsForLocation(loc, 'A new player appeared!');
  }
  tftiCheck(incomingPlayer, loc.id);
  console.log('\t> @' + loc.name + ': + ' + incomingPlayer.toLocaleString());
};

function reportNewPlayers(loc, players) {
  let combinedMessage = '';
  players.forEach(player => {
    if (!visiblePlayers.includes(player.ddrCode)) {
      console.log(`\t> @${loc.name}: + ` + player.toLocaleString());
    } else {
      if (combinedMessage) {
        combinedMessage += '\n';
      }
      combinedMessage += `+ ${player.name}    ${player.ddrCode}`;
    }
    console.log(`\t> @${loc.name}: + ` + player.toLocaleString());
    tftiCheck(player, loc.id);
  });
  if (combinedMessage) {
    pingChannelsForLocation(loc, monospace(combinedMessage));
  }
};

// Gets initial data
// Ideally, we'd just retrieveData() or do whatever we do repeatedly (no special case and no duplicated code for the first run)
function getInitialData(shop) {
  console.log(`getInitialData ${shop.id}`);
  return shop.cabs.map((cab, cabIndex) => {
    return getInitialDataForCab({
      cab,
      cabIndex,
      shop,
    });
  });
}

function getInitialDataForCab({cab, cabIndex, shop}) {
  return RequestPromise({jar: cab.cookiejar, uri: getUrl()})
  .then((body) => {
    const $ = cheerio.load(body);
    const dancerRows = $('td.dancer_name').get().length;
    if (dancerRows === 0) { // Error state - we won't work here. Happens during maintenance.
      // We have to restart.
      const error = `0 dancers found at ${shop.id} cab${cabIndex}. Restart the bot. username:` + $('#user_name .name_str').get().map(n => $(n).text()) + ' rival_list:' + $('table.tb_rival_list');
      console.error(error);
      throw new Error(error);
    }

    console.log(`getInitialData ${shop.id} @cab${cabIndex} found ${dancerRows} dancers:`);
    // Parses data
    for (var dancerIndex = 0; dancerIndex < Math.min(dancerRows, 7); dancerIndex++) { // Get up to 7 dancers, but don't break if we have less than 20
      cab.players[dancerIndex] = new Player({
        dancerName: $('td.dancer_name').eq(dancerIndex).text(),
        ddrCode: $('td.code').eq(dancerIndex).text(),
        loc: shop,
      });
      console.log(`--> ${shop.name} cab${cabIndex}: Player ${dancerIndex} received - ` + cab.players[dancerIndex].toLocaleString());
    }
  });
}

// Retrieves new data
// Ideally this should be done in update() instead
function retrieveData(loc) {
  // What happens if people are playing during this hour? This would run multiple times in the hour
  // In Japan, should be impossible (daily maintenance or shop closed)
  // In USA, everything should be closed
  var now = new Date();
  const isAmerica = loc.timeZone.startsWith('America') || loc.timeZone.indexOf('Honolulu') > -1;
  const usShouldReport = isAmerica && now.getUTCHours() === 12; // 12pm GMT+0 = 4am PST, 5am PDT. TODO: Make it 2am at the location's local time. Not important.
  const jpShouldReport = !isAmerica && now.getUTCHours() === 20; // 8pm GMT+0 = 5am Japan (beginning of maintenance)
  if (loc.todaysPlayers.length !== 0 && (usShouldReport || jpShouldReport)) {
    reportTodaysPlayers(loc);
    loc.todaysPlayers = [];
  }

  console.log('--> ' + loc.name + ': Retrieving data...');
  return loc.cabs.map((cab, cabIndex) => {
    return RequestPromise({jar: cab.cookiejar, uri: getUrl()}).then((body) => {
      const $ = cheerio.load(body);
      const dancerCount = $('td.dancer_name').length;
      if (dancerCount === 0) {
        const errorMessage = `--> ${loc.name} @cab${cabIndex}: No dancers found. Is this cookie set up correctly? ` + loc.cabs[cabIndex].cookieValue;
        console.error(errorMessage);
        throw new Error(errorMessage);
      } else {
        const receivedPlayers = [];
        for (dancerIndex = 0; dancerIndex < Math.min(dancerCount, 10); dancerIndex++) { // Only receive up to 10 players for debugging. 20 is too long, but might still be useful for extended downtime with lots of players playing.
          let dancerName = $('td.dancer_name').eq(dancerIndex).text();
          let ddrCode = $('td.code').eq(dancerIndex).text();
          if (dancerName === '') {
            console.error(`--> ${loc.name} @cab${cabIndex}: Ghost ${ddrCode} appeared. Spooky af :monkaPrim:`);
            // TODO: If we find the dancerName for this ddrCode later on, then we should populate the dancerName.
          }
          receivedPlayers[dancerIndex] = new Player({
            dancerName,
            ddrCode,
            loc,
          });
        }
        console.log(`--> ${loc.name} @cab${cabIndex}: Data received >` + receivedPlayers.toLocaleString());

        // Until we fix some logic, only put top 2 into loc.cabs.newPlayers
        for (dancerIndex = 0; dancerIndex < Math.min(dancerCount, 2); dancerIndex++) {
          loc.cabs[cabIndex].newPlayers[dancerIndex] = receivedPlayers[dancerIndex];
        }
      }
    });
  });
}

// Updates player lists using new data
function updatePlayerLists(loc) {
  loc.cabs.forEach(function(cab, cabIndex) {
    if (!cab.players.length) {
      return;
    }

    // if the previous first player shifted down a spot
    if (cab.players[0].ddrCode !== cab.newPlayers[0].ddrCode
      && cab.players[0].ddrCode === cab.newPlayers[1].ddrCode) {
      const incomingPlayer = cab.newPlayers[0];

      // Check for duplicates
      const foundPlayer = cab.players.find(function(player) {
        return player.ddrCode === incomingPlayer.ddrCode;
      });
      console.log(`--> ${loc.name}: cab${cabIndex}.players before: ` + cab.players.toLocaleString());
      // if duplicate, remove and unshift. else unshift and pop
      if (foundPlayer) {
        cab.players.splice(cab.players.indexOf(foundPlayer), 1);
        cab.players.unshift(incomingPlayer);
      } else {
        cab.players.unshift(incomingPlayer);
        if (cab.prunedPlayers > 0) {
          cab.prunedPlayers--;
        } else {
          cab.players.pop();
        }
      }
      console.log(`--> ${loc.name}: cab${cabIndex}.players after: ` + cab.players.toLocaleString());

      // find out if the player is on today's list
      const foundTodaysPlayer = loc.todaysPlayers.find(function(player) {
        return player.ddrCode === incomingPlayer.ddrCode;
      });

      // if duplicate, remove and unshift. else unshift
      if (foundTodaysPlayer) {
        incomingPlayer.firstTime = foundTodaysPlayer.firstTime;
        loc.todaysPlayers.splice(loc.todaysPlayers.indexOf(foundTodaysPlayer), 1);
        loc.todaysPlayers.unshift(incomingPlayer);
      } else {
        // New player
        loc.todaysPlayers.unshift(incomingPlayer);
        reportNewPlayer(loc, incomingPlayer);
      }
    } // else, if the first two players are different in any way
    else if (!(cab.players[0].ddrCode === cab.newPlayers[0].ddrCode
      && cab.players[1].ddrCode === cab.newPlayers[1].ddrCode)) {

      const incomingPlayer0 = cab.newPlayers[0];
      const incomingPlayer1 = cab.newPlayers[1];

      const foundPlayer0 = cab.players.find(function(player) {
        return player.ddrCode === incomingPlayer0.ddrCode;
      });
      const foundPlayer1 = cab.players.find(function(player) {
        return player.ddrCode === incomingPlayer1.ddrCode;
      });

      console.log(`--> ${loc.name}: cab${cabIndex}.players before: ` + cab.players.toLocaleString());
      if (foundPlayer1) {
        cab.players.splice(cab.players.indexOf(foundPlayer1), 1);
        cab.players.unshift(incomingPlayer1);
      } else {
        cab.players.unshift(incomingPlayer1);
        if (cab.prunedPlayers > 0) {
          cab.prunedPlayers--;
        } else {
          cab.players.pop();
        }
      }
      if (foundPlayer0) {
        cab.players.splice(cab.players.indexOf(foundPlayer0), 1);
        cab.players.unshift(incomingPlayer0);
      } else {
        cab.players.unshift(incomingPlayer0);
        if (cab.prunedPlayers > 0) {
          cab.prunedPlayers--;
        } else {
          cab.players.pop();
        }
      }
      console.log(`--> ${loc.name}: cab${cabIndex}.players after: ` + cab.players.toLocaleString());

      const foundTodaysPlayer0 = loc.todaysPlayers.find(function(player) {
        return player.ddrCode === incomingPlayer0.ddrCode;
      });
      const foundTodaysPlayer1 = loc.todaysPlayers.find(function(player) {
        return player.ddrCode === incomingPlayer1.ddrCode;
      });

      const playersToReport = [];
      if (foundTodaysPlayer1) {
        incomingPlayer1.firstTime = foundTodaysPlayer1.firstTime;
        loc.todaysPlayers.splice(loc.todaysPlayers.indexOf(foundTodaysPlayer1), 1);
        loc.todaysPlayers.unshift(incomingPlayer1);
      } else {
        loc.todaysPlayers.unshift(incomingPlayer1);
        playersToReport.push(incomingPlayer1);
      }

      if (foundTodaysPlayer0) {
        incomingPlayer0.firstTime = foundTodaysPlayer0.firstTime;
        loc.todaysPlayers.splice(loc.todaysPlayers.indexOf(foundTodaysPlayer0), 1);
        loc.todaysPlayers.unshift(incomingPlayer0);
      } else {
        loc.todaysPlayers.unshift(incomingPlayer0);
        playersToReport.push(incomingPlayer0);
      }

      reportNewPlayers(loc, playersToReport);
    }
  });
}

// Removes players who move cabs
function pruneData() {
  console.log('Pruning data. We should see this after we have retrieved all data.')
  ALL_LOCATIONS.forEach(function(loc1) {
    ALL_LOCATIONS.forEach(function(loc2) {
      loc1.cabs.forEach(function(cab1) {
        loc2.cabs.forEach(function(cab2) {
          if (cab1 !== cab2) {
            cab1.newPlayers.forEach(function(newPlayer) {
              var foundPlayer = cab2.players.find(function(player) {
                return player.ddrCode === newPlayer.ddrCode;
              });
              if (foundPlayer) {
                console.log('--> ' + loc2.name + ' to ' + loc1.name + ': stop switching cabs pls, ' + foundPlayer.toLocaleString());
                cab2.players.splice(cab2.players.indexOf(foundPlayer), 1);
                cab2.prunedPlayers++;
              }
            });
          }
        });
      });
    });
  });
}

function update() {
  const locationPromises = ALL_LOCATIONS.map(loc => {
    const cabPromises = retrieveData(loc);
    return Promise.all(cabPromises)
    .then(() => {
      pruneData();
      updatePlayerLists(loc);
      updateChannelsTopicForLocation(loc);
    })
    .catch((err) => {
      console.error(err, `${getUrl()} failed, retrying ${loc.id} with URL ${getUrl()}`);
      return Promise.all(retrieveData(loc))
      .then(() => {
        pruneData();
        updatePlayerLists(loc);
        updateChannelsTopicForLocation(loc);
      })
      .catch(err => {
        const errorMessage = '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ Damn we failed on the retry, too @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@';
        console.error(errorMessage);
        throw new Error(errorMessage);
      });
    });
  });

  Promise.all(locationPromises)
  .catch(err => {
    console.log(err);
    console.log('\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n--> Error detected in at least 1 cab. \n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n');
  })
  .then(() => {
    console.log('update() loop complete');
    setTimeout(update, REFRESH_INTERVAL);
  });
}

// Initialize Discord Bot
var client = new Discord.Client();

client.on('ready', () => {
  console.log('Connected');
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(client.user.username + ' - (' + client.user.id + ')');
});

// Reused in a few places
// Plus we have the same channel name on multiple guilds
function getChannelsWithName(name) {
  return client.channels.filter(channel => channel.name === name);
};

function monospace(message) {
  return '```' + (message || ' ') + '```';
}

function pingChannel(channel, message) {
  console.info(`Sending message to ${channel.guild.name}/#${channel.name}: ${message}`);
  channel.send(message);
}

function pingChannelsForLocation(loc, message) {
  console.info('pingChannel ' + loc.id + ': ' + message);
  const channels = getChannelsWithName(loc.id);
  if (!channels.size) {
    console.error('Could not find channels for location ' + loc.id);
  } else {
    channels.forEach((channel) => pingChannel(channel, message));
  }
}
function reportTodaysPlayers(loc) {
  getChannelsWithName(loc.id).forEach(channel => reportTodaysPlayersForChannel(channel, loc));
}

// https://medium.com/@Dragonza/four-ways-to-chunk-an-array-e19c889eac4
function chunk(array, size) {
  const chunked_arr = [];
  let index = 0;
  while (index < array.length) {
    chunked_arr.push(array.slice(index, size + index));
    index += size;
  }
  return chunked_arr;
}

function reportTodaysPlayersForChannel(channel, loc) {
  const todaysPlayers = getTodaysPlayers(loc);
  const today = loc.todaysPlayers.length === 0 ? 'today.' : 'today:';
  const s = loc.todaysPlayers.length === 1 ? '' : 's';
  let message = `${loc.todaysPlayers.length} player${s} ${today}`; // TODO: replace with YYYY-MM-DD
  // Instead of trying to compute the perfect string length <= 2000, just safely/simply cut off at 48 players per message.
  chunk(todaysPlayers, 48).forEach(chunkOf48Players => {
    message += monospace(chunkOf48Players.join('\n'));
    console.info(`Sending message to ${channel.guild.name}/#${channel.name}: ${message}`);
    channel.send(message);
    message = '';
  });
  if (message) {
    channel.send(message);
  }
}

function summaryHereString(loc, { includeList = true } = {}) {
  const currentTime = new Date();
  const nowString = timeString(currentTime, loc.timeZone);

  let numActivePlayers = 0;
  const playerNamesTimes = [];

  loc.todaysPlayers.forEach(function(player) {
    const timeSinceSeen = timeDifferential(currentTime, player.lastTime);
    if (timeSinceSeen.minOnly <= RECENT_PLAYER_CUTOFF_MINUTES) {
      numActivePlayers++;
      if (visiblePlayers.includes(player.ddrCode)) {
        playerNamesTimes.push(`${player.name} ${timeSinceSeen.minOnly}m`);
      } else {
        playerNamesTimes.push(`${timeSinceSeen.minOnly}m`);
      }
    }
  });

  let summaryHereString;
  if (loc.todaysPlayers.length === 0) {
    summaryHereString = `${nowString}: 0 players today.`;
  } else if (numActivePlayers === 0) {
    // TODO: If a hiddenPlayer is here, we'll still report them. Since this is pretty rare, just don't solve for this for now.
    const players = (loc.todaysPlayers.length === 1) ? "Today's only player has" : `All ${loc.todaysPlayers.length} players today have`;
    const timeSinceSeen = timeDifferential(currentTime, loc.todaysPlayers[0].lastTime);
    summaryHereString = `${nowString}: ${players} left! :eyes:`;
    if (visiblePlayers.includes(loc.todaysPlayers[0].ddrCode)) {
      summaryHereString += ` Last player seen: ${loc.todaysPlayers[0].name} ${timeSinceSeen.str} ago.`;
    }
  } else {
    const s = (numActivePlayers === 1) ? '' : 's';
    summaryHereString = `${nowString}: ${numActivePlayers}/${loc.todaysPlayers.length} player${s} in the last ${RECENT_PLAYER_CUTOFF_MINUTES} minutes. :eyes: ${tftiEmoji}`;
    if (includeList && playerNamesTimes.length !== 0) {
      let numAnonymousPlayers = numActivePlayers - playerNamesTimes.length;
      let playersNamesTimesString = playerNamesTimes.join(", ");
      let othersString = numAnonymousPlayers > 0 ? ` and ${numAnonymousPlayers} others` : '';
      let commaString = othersString && playerNamesTimes.length > 1 ? ',' : '';
      summaryHereString += ' (' + playersNamesTimesString + commaString + othersString + ')';
    }
  }

  return summaryHereString;
}

function updateChannelTopic(loc, channel) {
  channel.setTopic(summaryHereString(loc))
    .then(updated => console.log(`Updated topic in ${updated.guild.name}/#${loc.id}: ${updated.topic}`))
    .catch((error) => console.error('Failed to update ' + loc.id, error));
}

function updateChannelsTopicForLocation(loc) {
  const channels = getChannelsWithName(loc.id);
  if (!channels.size) {
    console.error('Could not find channels for location ' + loc.id);
  } else {
    channels.forEach((channel) => updateChannelTopic(loc, channel));
  }
}

client.on('error', console.error);

client.on('message', message => {
  if (message.content.substring(0, 1) == '!') {
    const args = message.content.split(' ');
    const cmd = args[0].substring(1);
    console.info('Command ' + cmd + ' received from ' + message.author.tag);

    const isAdmin = adminDiscordTags.includes(message.author.tag);

    if (isAdmin && cmd === 'yeet') {
      return ALL_LOCATIONS.forEach((loc) => reportTodaysPlayers(loc));
    }

    const channel = message.channel;
    const shop = ALL_LOCATIONS.find((shop) => shop.id === channel.name);

    if (!shop) {
      console.error('Could not find shop with id ' + channel.name);
      return;
    }

    if (isAdmin) {
      if (cmd === 'all') {
        reportTodaysPlayersForChannel(channel, shop);
      } else if (cmd === 'here') {
        const recentPlayers = getRecentPlayers(shop);
        const response = summaryHereString(shop, {includeList: false}) + monospace(recentPlayers.join('\n'));
        console.info(`Sending message to ${channel.guild.name}/#${channel.name}: ${response}`);
        channel.send(response);
      } else if (cmd === 'addcab') {
        const cookieValue = args[1];
        const cab = new Cab(cookieValue);
        const cabIndex = shop.cabs.length;
        shop.cabs.push(cab);
        getInitialDataForCab({
          cab,
          cabIndex,
          shop,
        }).then(() => {
          channel.send('Added');
        }).catch((err) => {
          console.error('Failed to add cab', err);
        });
      } else if (cmd === 'removecab') {
        const cabIndex = args[1];
        console.log('before remove', shop.cabs.map(cab => cab.cookieValue));
        shop.cabs.splice(cabIndex, 1);
        console.log('after remove', shop.cabs.map(cab => cab.cookieValue));
        channel.send('Removed');
      } else if (cmd === 'addvisibleplayer') {
        const ddrCode = args[1];
        visiblePlayers.push(ddrCode);
        channel.send('Added');
      }
    } else if (cmd === 'whose' || cmd === 'here') {
      channel.send('Check the channel topic. (on mobile, swipe left from the right edge of your screen)');
    }
  }
});

// Initialize locations
const CONFIG_LOCATIONS = config.get('shops') || [];
const ALL_LOCATIONS = CONFIG_LOCATIONS.map((shop) => {
  return new Location({
    name: shop.id,
    id: shop.id,
    timeZone: shop.timeZone,
    cabs: shop.cookies.map((cookie) => {return new Cab(cookie);}),
  });
});

function getAllInitialData() {
  console.log('getAllInitialData');

  const promises = ALL_LOCATIONS.map(loc => {
    return Promise.all(getInitialData(loc))
    .catch(err => {
      console.error(getUrl(), 'failed,', err, 'retrying', loc.id, getUrl());
      return Promise.all(getInitialData(loc))
      .then(() => {
        updateChannelsTopicForLocation(loc);
      })
      .catch(err => {
        const errorMessage = `Damn we failed on the retry, too. ${loc.id}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      });
    })
    .then(() => {
      updateChannelsTopicForLocation(loc);
    });
  });
  return Promise.all(promises)
  // We would use .finally() if it existed, but .then() is fine since we'll exit on an error anyways.
  .then(() => {
    console.log('getAllInitialData complete, starting update loop');
    setTimeout(update, REFRESH_INTERVAL);
  });
}

const DISCORD_BOT_TOKEN = config.get('discordBotToken');
if (!DISCORD_BOT_TOKEN) {
  console.error('Missing discordBotToken config key.');
  process.exit();
}
client.login(DISCORD_BOT_TOKEN)
  .then(getAllInitialData)
  .catch((err) => {
    console.error('--> Failed to get initial data. Restart the bot.');
    process.exit();
    throw err;
  });
